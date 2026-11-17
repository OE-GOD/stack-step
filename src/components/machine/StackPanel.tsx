import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { groupDigits, hex, type MachineState, type StackSlot } from '../../emulator'
import { Button } from '../ui/Button'
import { cx } from '../ui/cx'
import { ArrowRightIcon } from '../ui/icons'
import { HexValue } from './HexValue'
import { MachinePanel } from './MachinePanel'
import {
  byteHex,
  MORE_STACK_ROWS,
  rbpInStack,
  rbpOffset,
  stackBoxName,
  stackRows,
  stepKey,
  wasPushed,
  type StackRow,
} from './machineView'
import { edgeFade, useScrollEdges } from './useScrollEdges'
import { STACK_CAPTION } from './words'

export interface StackPanelProps {
  machine: MachineState
  /** Small boxes, no card (MiniStepper). */
  compact?: boolean
  title?: string
  /** The card fills the height its parent gives it; the list scrolls inside. */
  fill?: boolean
  /** Extra classes for the scrolling list, e.g. a max height (`max-h-80`). */
  listClassName?: string
  className?: string
}

/** "rsp →" or "rbp →" in the pointer's own color. The box's name says it in words. */
function PointerMark({ name }: { name: 'rsp' | 'rbp' }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex items-center justify-end gap-0.5 font-mono text-xs font-bold whitespace-nowrap max-lg:text-sm',
        name === 'rsp' ? 'text-rsp' : 'text-rbp',
      )}
    >
      {name}
      <ArrowRightIcon size={13} strokeWidth={2.5} />
    </span>
  )
}

/**
 * The 8 bytes of one box, lowest address first: how little-endian order looks in memory.
 * Under them, one plain sentence with the box's own value as the example.
 */
function SlotBytes({
  id,
  slot,
  ref,
}: {
  id: string
  slot: StackSlot
  ref?: Ref<HTMLDivElement>
}): ReactNode {
  const written = slot.bytes.filter((byte) => byte !== null)
  const lowest = slot.bytes[0]
  return (
    <div
      ref={ref}
      id={id}
      className="mt-1 mb-1.5 ml-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 @[20rem]:ml-14"
    >
      <p className="text-xs text-muted max-lg:text-sm">
        The 8 bytes in memory, lowest address first:
      </p>
      <ol className="mt-1.5 grid w-max max-w-full grid-cols-8 gap-0.5 font-mono">
        {slot.bytes.map((byte, index) => {
          const address = slot.address + BigInt(index)
          return (
            <li
              key={index}
              className="flex min-w-[1.625rem] flex-col items-center rounded-[3px] border border-line bg-surface px-0.5 py-0.5"
            >
              <span className="sr-only">
                {hex(address)}: {byte === null ? 'not set yet' : `0x${byteHex(byte)}`}
              </span>
              <span
                aria-hidden="true"
                className="text-[0.625rem] leading-tight text-muted max-lg:text-xs"
              >
                {byteHex(Number(address & 0xffn))}
              </span>
              <span
                aria-hidden="true"
                className="text-xs leading-tight font-semibold text-ink max-lg:text-sm"
              >
                {byte === null ? '··' : byteHex(byte)}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="mt-1.5 text-xs text-pretty text-muted max-lg:text-sm">
        The small numbers are the last 2 digits of each byte&apos;s address.{' '}
        {slot.value !== null && written.length === 8 && lowest !== null ? (
          <>
            <span className="font-mono">{hex(slot.value)}</span> is stored as{' '}
            <span className="font-mono">
              {slot.bytes.map((byte) => (byte === null ? '··' : byteHex(byte))).join(' ')}
            </span>
            : the lowest byte (<span className="font-mono">{byteHex(lowest)}</span>) comes first.
          </>
        ) : (
          'The lowest byte of a value comes first.'
        )}
      </p>
    </div>
  )
}

interface StackRowProps {
  slot: StackSlot
  /** "rbp−8" when rbp points into the stack; else null. */
  offset: string | null
  /** The last step pushed this box: it slides in. */
  pushed: boolean
  /** The step on the screen while the box is marked (0 otherwise): restarts the flash. */
  flashKey: number
  expanded: boolean
  onToggle: (address: bigint) => void
  compact: boolean
}

const StackBox = memo(function StackBox({
  slot,
  offset,
  pushed,
  flashKey,
  expanded,
  onToggle,
  compact,
}: StackRowProps): ReactNode {
  const bytesId = useId()
  const marked = slot.changed
  // A box opened near the bottom of the list shows its bytes below what is in sight:
  // scroll them into sight (as little as possible). Only when the student opens it.
  const bytesRef = useRef<HTMLDivElement | null>(null)
  const wasExpanded = useRef(expanded)
  useLayoutEffect(() => {
    const bytes = bytesRef.current
    if (expanded && !wasExpanded.current && bytes !== null && 'scrollIntoView' in bytes) {
      bytes.scrollIntoView({ block: 'nearest' })
    }
    wasExpanded.current = expanded
  }, [expanded])
  return (
    <li
      data-stack-box={hex(slot.address)}
      data-rsp={slot.isRsp ? 'true' : undefined}
      data-changed={marked ? 'true' : undefined}
    >
      {/*
        The box is drawn for the eyes; one button lies over the whole row, empty, and its
        name says it all for screen readers: what the box is first, then its value, its
        address and the pointers. (Speech input finds it by the words of its label.)
      */}
      <div className="group relative flex items-stretch gap-1.5">
        <span aria-hidden="true" className="flex w-12.5 shrink-0 flex-col justify-center gap-0.5">
          {slot.isRsp && <PointerMark name="rsp" />}
          {slot.isRbp && <PointerMark name="rbp" />}
        </span>
        <span
          key={pushed ? flashKey : 'still'}
          aria-hidden="true"
          className={cx(
            'min-w-0 flex-1 rounded-md border px-2.5 transition-colors',
            compact ? 'py-1' : 'py-1.5',
            slot.dead
              ? 'border-dashed border-line-strong bg-transparent'
              : 'border-line-strong bg-surface group-hover:bg-surface-2',
            // A bar on the left of a changed box (a shape as well as the dot), and the
            // blue ring of the box rsp points at.
            marked &&
              slot.isRsp &&
              'shadow-[inset_3px_0_0_var(--c-changed),0_0_0_2px_var(--c-rsp)]',
            marked && !slot.isRsp && 'shadow-[inset_3px_0_0_var(--c-changed)]',
            !marked && slot.isRsp && 'shadow-[0_0_0_2px_var(--c-rsp)]',
            pushed && 'animate-slide-in',
          )}
        >
          <span className="block">
            {slot.value === null ? (
              <span className="font-mono text-[0.8125rem] text-muted italic max-lg:text-sm">
                not set yet
              </span>
            ) : (
              <HexValue
                value={slot.value}
                changed={slot.changed}
                flashKey={flashKey}
                className={cx('text-[0.8125rem] max-lg:text-sm', slot.dead && 'text-muted')}
              />
            )}
          </span>
          {slot.label !== null && (
            <span
              className={cx(
                'block text-[0.8125rem] leading-snug font-medium max-lg:text-sm',
                slot.dead ? 'text-muted' : 'text-ink',
              )}
            >
              {slot.label}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted max-lg:text-sm">
            <HexValue value={slot.address} digits={0} dimZeros={false} reserveMark={false} />
            {offset !== null && <span className="font-mono">{offset}</span>}
            {slot.dead && (
              <span className="ml-auto rounded-full border border-dashed border-line-strong px-1.5 text-[0.6875rem] font-semibold text-muted max-lg:text-sm">
                leftover
              </span>
            )}
          </span>
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? bytesId : undefined}
          aria-label={stackBoxName(slot, offset)}
          onClick={() => onToggle(slot.address)}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
      </div>
      {expanded && <SlotBytes ref={bytesRef} id={bytesId} slot={slot} />}
    </li>
  )
})

/** Boxes that nobody wrote yet, as one quiet row. */
function UnsetRow({ row }: { row: Extract<StackRow, { kind: 'unset' }> }): ReactNode {
  return (
    <li data-stack-gap="" className="flex items-stretch gap-1.5">
      <span aria-hidden="true" className="w-12.5 shrink-0" />
      <span className="min-w-0 flex-1 rounded-md border border-dashed border-line px-2.5 py-1.5 text-[0.8125rem] text-muted max-lg:text-sm">
        <span className="block">
          {groupDigits(row.count)} more {row.count === 1 ? 'box' : 'boxes'}, not set yet
        </span>
        <span className="block font-mono text-xs break-all max-lg:text-sm">
          {hex(row.high)} to {hex(row.low)}
        </span>
      </span>
    </li>
  )
}

/** Boxes left out of a very long stack, with a button that shows more of them. */
function HiddenRow({ count, onMore }: { count: number; onMore: () => void }): ReactNode {
  return (
    <li data-stack-gap="" className="flex items-center gap-1.5">
      <span aria-hidden="true" className="w-12.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-line px-2.5 py-1 text-[0.8125rem] text-muted max-lg:text-sm">
        {groupDigits(count)} more {count === 1 ? 'box is' : 'boxes are'} not shown.
        <Button size="sm" variant="ghost" onClick={onMore} className="-my-0.5 underline">
          Show more
        </Button>
      </span>
    </li>
  )
}

/**
 * The stack as 8-byte boxes, high addresses at the top: rsp and rbp arrows, labels,
 * offsets from rbp, leftovers below rsp, and the bytes of a box in memory order.
 *
 * However big the stack gets (`sub rsp, 1000000`), the list stays short: boxes that
 * nobody wrote are one row, and a very deep stack shows its top and the part around rsp
 * and rbp (see `stackRows`).
 */
export function StackPanel({
  machine,
  compact = false,
  title = 'Stack',
  fill = false,
  listClassName,
  className,
}: StackPanelProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<bigint>>(() => new Set())
  const toggle = useCallback((address: bigint) => {
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(address)) next.add(address)
      return next
    })
  }, [])
  const [revealed, setRevealed] = useState(0)
  const showMore = useCallback(() => setRevealed((count) => count + MORE_STACK_ROWS), [])

  const listRef = useRef<HTMLOListElement | null>(null)
  const { stack, version, lastStep } = machine
  const rows = useMemo(() => stackRows(stack, revealed), [stack, revealed])
  const showOffsets = useMemo(() => rbpInStack(stack), [stack])
  const key = stepKey(lastStep)
  const edges = useScrollEdges(listRef, true, version)

  // Keep the box rsp points at in view. Only the list scrolls, never the page.
  useLayoutEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('[data-rsp="true"]')
    if (list === null || list === undefined || row === null || row === undefined) return
    if (list.scrollHeight <= list.clientHeight) return
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    if (rowBox.top >= listBox.top && rowBox.bottom <= listBox.bottom) return
    list.scrollTop += rowBox.top - listBox.top - (list.clientHeight - rowBox.height) / 2
  }, [key, version])

  return (
    <MachinePanel
      title={title}
      compact={compact}
      fill={fill}
      className={cx('@container', className)}
    >
      <p className="text-xs text-muted max-lg:text-sm">{STACK_CAPTION}</p>
      <ol
        ref={listRef}
        className={cx(
          // The padding keeps the rsp ring and the focus outline inside the scrolling box.
          '-mx-1 mt-1 space-y-1.5 overflow-y-auto overscroll-contain p-1',
          fill && 'min-h-0 flex-1',
          edgeFade(edges),
          listClassName,
        )}
      >
        {rows.map((row, index) => {
          if (row.kind === 'unset') return <UnsetRow key={`unset-${row.high}`} row={row} />
          if (row.kind === 'hidden') {
            return <HiddenRow key={`hidden-${index}`} count={row.count} onMore={showMore} />
          }
          const { slot } = row
          const pushed = wasPushed(slot, machine)
          const marked = slot.changed || pushed
          return (
            <StackBox
              key={slot.address.toString()}
              slot={slot}
              offset={showOffsets ? rbpOffset(slot.address, machine.registers.rbp) : null}
              pushed={pushed}
              flashKey={marked ? key : 0}
              expanded={expanded.has(slot.address)}
              onToggle={toggle}
              compact={compact}
            />
          )
        })}
      </ol>
    </MachinePanel>
  )
}
