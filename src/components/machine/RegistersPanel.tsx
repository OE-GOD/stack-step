import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { hex, type MachineState, type Program, type Reg64 } from '../../emulator'
import { cx } from '../ui/cx'
import { HexValue } from './HexValue'
import { MachinePanel } from './MachinePanel'
import {
  changedRegisters,
  clearedTopHalves,
  junkRegisters,
  REGISTER_GROUPS,
  stepKey,
} from './machineView'
import { nextWords } from './nextText'
import { RegisterRow } from './RegisterRow'

export interface RegistersPanelProps {
  machine: MachineState
  /** The program the machine runs: it tells which name a step wrote (for the 32-bit rule). */
  program?: Program | null
  /**
   * Which registers to show, in this order. Default: all sixteen, in the order the course
   * teaches them, in three families (rax–rdx · rsi rdi rbp rsp · r8–r15).
   */
  registers?: readonly Reg64[]
  /** Show rip (the address of the next instruction) under the registers. Default true. */
  showRip?: boolean
  /** Small rows, no card (MiniStepper). */
  compact?: boolean
  title?: string
  /** The list scrolls inside the card when it is taller than the space it gets. */
  fill?: boolean
  /** Shown inside the card, under the list (it does not scroll with it): the flags. */
  footer?: ReactNode
  className?: string
}

interface RipRowProps {
  machine: MachineState
  compact: boolean
}

/**
 * rip is not a box to open: it always holds the address of the next instruction. Its
 * value has all 16 digits, like every other register; under it, the few words that say
 * where it points ("line 14", "inside printf").
 */
function RipRow({ machine, compact }: RipRowProps): ReactNode {
  const { rip } = machine
  const note = nextWords(machine)
  return (
    <li
      data-register="rip"
      className={cx('border-t border-line py-0.5', compact ? 'px-2.5' : 'px-3')}
    >
      {/* One sentence for screen readers; the parts below are for the eyes. */}
      <span className="sr-only">{`rip: ${hex(rip)}, next: ${note}`}</span>
      <span aria-hidden="true" className="flex items-center gap-2">
        {/* The place of the chevron in the other rows. */}
        <span className="w-3.5 shrink-0" />
        <span className="w-8 shrink-0 font-mono text-sm font-semibold text-ink">rip</span>
        <HexValue
          value={rip}
          reserveMark={false}
          className={compact ? 'text-[0.8125rem] max-lg:text-sm' : 'text-sm'}
        />
      </span>
      {/* Under the value, in line with it: after the chevron, the name and two gaps. A
          short laptop screen has no room for it; the status line and the code say it too. */}
      <span
        aria-hidden="true"
        className="block truncate pl-[3.875rem] text-xs leading-4 text-muted max-lg:text-sm max-lg:leading-5 lg:[@media(max-height:46rem)]:hidden"
      >
        {note}
      </span>
    </li>
  )
}

/** "Click to see eax, ax, al" with a mouse, "Tap …" on a touch screen. */
function PartsHint(): ReactNode {
  return (
    <span className="text-xs text-muted max-lg:text-sm">
      <span className="pointer-coarse:hidden">Click to see eax, ax, al</span>
      <span className="pointer-fine:hidden">Tap to see eax, ax, al</span>
    </span>
  )
}

/**
 * The registers: one row per register (a button that opens its parts), and rip.
 * Rows whose value changed in the last step are bold, with a dot, a bar and a short
 * flash. After a library call, the registers it left junk in say "junk" instead.
 */
export function RegistersPanel({
  machine,
  program = null,
  registers,
  showRip = true,
  compact = false,
  title = 'Registers',
  fill = false,
  footer,
  className,
}: RegistersPanelProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<Reg64>>(() => new Set())
  const toggle = useCallback((name: Reg64) => {
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }, [])

  const { lastStep } = machine
  const changed = useMemo(() => changedRegisters(lastStep), [lastStep])
  const junk = useMemo(() => junkRegisters(lastStep), [lastStep])
  const cleared = useMemo(() => clearedTopHalves(lastStep, program), [lastStep, program])
  const key = stepKey(lastStep)
  const groups = registers === undefined ? REGISTER_GROUPS : [registers]

  return (
    <MachinePanel
      title={title}
      compact={compact}
      flush
      fill={fill}
      className={className}
      actions={compact ? undefined : <PartsHint />}
    >
      <ul
        className={cx(
          compact && 'overflow-hidden rounded-lg border border-line bg-surface',
          fill && 'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        )}
      >
        {groups.map((group, groupIndex) =>
          group.map((name, index) => {
            const isChanged = changed.has(name)
            return (
              <RegisterRow
                key={name}
                name={name}
                value={machine.registers[name]}
                changed={isChanged}
                junk={junk.has(name)}
                flashKey={isChanged ? key : 0}
                expanded={expanded.has(name)}
                clearedFrom={cleared.get(name) ?? null}
                onToggle={toggle}
                compact={compact}
                groupStart={groupIndex > 0 && index === 0}
              />
            )
          }),
        )}
        {showRip && <RipRow machine={machine} compact={compact} />}
      </ul>
      {footer}
    </MachinePanel>
  )
}
