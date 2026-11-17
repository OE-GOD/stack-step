import { memo, useCallback, useId, useState, type ReactNode } from 'react'
import { FLAG_NAMES, type Bit, type FlagName, type MachineState } from '../../emulator'
import { cx } from '../ui/cx'
import { ChangedMark } from './ChangedMark'
import { MachinePanel } from './MachinePanel'
import { stepKey } from './machineView'
import { FLAG_CAPTIONS, FLAG_EXPLANATIONS } from './words'

export interface FlagsPanelProps {
  machine: MachineState
  /** Small lights, no card, no captions (MiniStepper). */
  compact?: boolean
  /**
   * No card of its own: a labelled strip to put inside another card (the stepper page
   * puts it at the bottom of the Registers card, so the flags take little height).
   */
  embedded?: boolean
  title?: string
  className?: string
}

interface FlagLightProps {
  name: FlagName
  value: Bit
  changed: boolean
  flashKey: number
  compact: boolean
  /** Show the one-word caption under the light ("carry"). */
  caption: boolean
  /** This light's explanation is showing. */
  active: boolean
  descriptionId: string
  onShow: (name: FlagName) => void
  onHide: (name: FlagName) => void
  onToggle: (name: FlagName) => void
}

/** One flag: a filled dot for 1, a hollow ring for 0 (a shape, not only a color), and the digit. */
const FlagLight = memo(function FlagLight({
  name,
  value,
  changed,
  flashKey,
  compact,
  caption,
  active,
  descriptionId,
  onShow,
  onHide,
  onToggle,
}: FlagLightProps): ReactNode {
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-flag={name}
        aria-describedby={descriptionId}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') onShow(name)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') onHide(name)
        }}
        onFocus={() => onShow(name)}
        onBlur={() => onHide(name)}
        onClick={() => onToggle(name)}
        className={cx(
          'relative flex w-full cursor-help flex-col items-center justify-center rounded-lg border px-1 transition-colors pointer-coarse:min-h-11',
          compact ? 'min-h-9 py-1' : 'py-1',
          changed ? 'border-changed' : 'border-line',
          active ? 'bg-primary-soft' : 'bg-surface hover:bg-surface-2',
        )}
      >
        <span
          key={changed ? flashKey : 'still'}
          className={cx(
            'flex items-center gap-1.5 rounded-sm px-1 font-mono text-sm leading-5',
            changed && 'animate-flash font-bold',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'inline-block size-2.5 rounded-full border-2',
              value === 1 ? 'border-ink bg-ink' : 'border-muted bg-transparent',
            )}
          />
          <span className="text-ink">{name}</span>
          <span className={cx(value === 0 && !changed ? 'text-muted' : 'text-ink')}>{value}</span>
        </span>
        {caption && (
          <span className="text-xs leading-tight text-muted max-lg:text-sm">
            {FLAG_CAPTIONS[name]}
          </span>
        )}
        <ChangedMark changed={changed} className="absolute top-1 right-1" />
      </button>
    </li>
  )
})

/** "Point at a flag to learn more" (mouse) or "Tap a flag to learn more" (touch). */
function Hint(): ReactNode {
  return (
    <span className="text-xs text-muted max-lg:text-sm">
      <span className="pointer-coarse:hidden">Point at a flag to learn more</span>
      <span className="pointer-fine:hidden">Tap a flag to learn more</span>
    </span>
  )
}

/**
 * The four flags CF, ZF, SF, OF. Each light explains itself on hover, on keyboard focus
 * and on tap: the sentence floats above the lights (it takes no room of its own).
 */
export function FlagsPanel({
  machine,
  compact = false,
  embedded = false,
  title = 'Flags',
  className,
}: FlagsPanelProps): ReactNode {
  const baseId = useId()
  const headingId = useId()
  // The light whose sentence shows: shown by hover or focus, or pinned by a tap or click.
  const [pinned, setPinned] = useState<FlagName | null>(null)
  const [hovered, setHovered] = useState<FlagName | null>(null)
  const active = hovered ?? pinned

  const show = useCallback((name: FlagName) => setHovered(name), [])
  const hide = useCallback(
    (name: FlagName) => setHovered((current) => (current === name ? null : current)),
    [],
  )
  const toggle = useCallback(
    (name: FlagName) => setPinned((current) => (current === name ? null : name)),
    [],
  )

  const changed = new Set(machine.lastStep?.diff.flags.map((change) => change.flag) ?? [])
  const key = stepKey(machine.lastStep)
  const activeIndex = active === null ? -1 : FLAG_NAMES.indexOf(active)

  const lights = (
    <>
      <div className="relative">
        <ul className="grid grid-cols-4 gap-1.5">
          {FLAG_NAMES.map((name) => (
            <FlagLight
              key={name}
              name={name}
              value={machine.flags[name]}
              changed={changed.has(name)}
              flashKey={changed.has(name) ? key : 0}
              compact={compact}
              caption={!compact}
              active={active === name}
              descriptionId={`${baseId}-${name}`}
              onShow={show}
              onHide={hide}
              onToggle={toggle}
            />
          ))}
        </ul>
        {/* For the eyes: the sentence of the light that is pointed at, focused or tapped. */}
        {active !== null && (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 animate-fade-in rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-lg"
          >
            {FLAG_EXPLANATIONS[active]}
            {/* A small arrow down to the light. */}
            <span
              aria-hidden="true"
              className="absolute -bottom-[5px] size-2.5 rotate-45 border-r border-b border-line-strong bg-surface"
              style={{ left: `calc(${(activeIndex * 2 + 1) * 12.5}% - 5px)` }}
            />
          </p>
        )}
      </div>
      {/* For screen readers: each light is described by its own sentence. `hidden` keeps
          them out of the reading order (they would be read twice), and aria-describedby
          still finds them. */}
      <div hidden>
        {FLAG_NAMES.map((name) => (
          <span key={name} id={`${baseId}-${name}`}>
            {FLAG_EXPLANATIONS[name]}
          </span>
        ))}
      </div>
    </>
  )

  if (embedded) {
    return (
      <section
        aria-labelledby={headingId}
        data-flags=""
        className={cx('border-t border-line px-3 pt-1.5 pb-2.5', className)}
      >
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-sm font-semibold text-ink">
            {title}
          </h3>
          <Hint />
        </div>
        {lights}
      </section>
    )
  }

  return (
    <MachinePanel
      title={title}
      compact={compact}
      className={className}
      actions={compact ? undefined : <Hint />}
    >
      {lights}
    </MachinePanel>
  )
}
