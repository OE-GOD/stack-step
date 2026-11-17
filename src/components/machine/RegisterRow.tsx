import { memo, useId, type ReactNode } from 'react'
import type { Reg64 } from '../../emulator'
import { cx } from '../ui/cx'
import { ChevronRightIcon } from '../ui/icons'
import { HexValue } from './HexValue'
import { registerName } from './machineView'
import { RegisterParts } from './RegisterParts'

export interface RegisterRowProps {
  name: Reg64
  value: bigint
  changed: boolean
  /**
   * A library call (printf, scanf, …) left junk in this register: its value changed, but
   * it is not a result. Marked with a word and a hatched background, not as a change.
   */
  junk?: boolean
  /** The step on the screen while `changed` (0 otherwise), so the flash restarts on each step. */
  flashKey: number
  expanded: boolean
  /** The value before the step, when a 32-bit write just cleared the top half; else null. */
  clearedFrom: bigint | null
  onToggle: (name: Reg64) => void
  compact?: boolean
  /** The first row of a family (rsi, r8): a line above it. */
  groupStart?: boolean
}

/** The two stack pointers keep their colors everywhere: rsp blue, rbp purple. */
function nameColor(name: Reg64): string {
  if (name === 'rsp') return 'text-rsp'
  if (name === 'rbp') return 'text-rbp'
  return 'text-ink'
}

/** A soft hatch: "this value is junk", drawn with a shape, not only a color. */
const JUNK_BACKGROUND =
  'bg-[repeating-linear-gradient(135deg,var(--c-surface-2)_0_6px,transparent_6px_12px)]'

/**
 * One register: a button with its name and value. It opens the view of its parts
 * (eax, ax, ah, al, …). Memoised: a step re-renders only the rows that changed.
 */
export const RegisterRow = memo(function RegisterRow({
  name,
  value,
  changed,
  junk = false,
  flashKey,
  expanded,
  clearedFrom,
  onToggle,
  compact = false,
  groupStart = false,
}: RegisterRowProps): ReactNode {
  const partsId = useId()
  return (
    <li
      data-register={name}
      data-changed={changed ? 'true' : undefined}
      data-junk={junk ? 'true' : undefined}
      className={cx(groupStart && 'border-t border-line')}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? partsId : undefined}
        aria-label={registerName(name, value, changed, junk)}
        onClick={() => onToggle(name)}
        className={cx(
          'flex w-full cursor-pointer items-center gap-2 text-left transition-colors hover:bg-surface-2 pointer-coarse:min-h-11',
          compact ? 'min-h-8 px-2.5' : 'min-h-7 px-3 lg:[@media(max-height:46rem)]:min-h-6',
          // A changed row: a soft tint and a bar on its left edge (a shape, not only a color).
          changed && 'bg-changed-soft/40 shadow-[inset_3px_0_0_var(--c-changed)]',
          junk && JUNK_BACKGROUND,
        )}
      >
        <ChevronRightIcon
          size={14}
          className={cx('text-muted transition-transform', expanded && 'rotate-90')}
        />
        <span className={cx('w-8 shrink-0 font-mono text-sm font-semibold', nameColor(name))}>
          {name}
        </span>{' '}
        <HexValue
          value={value}
          changed={changed}
          flashKey={flashKey}
          className={compact ? 'text-[0.8125rem] max-lg:text-sm' : 'text-sm'}
        />
        {/* (The space keeps "junk" a word of its own for speech input; flex hides it.) */}
        {junk && ' '}
        {junk && (
          <span className="ml-auto rounded-full border border-dashed border-line-strong px-1.5 text-[0.6875rem] leading-4 font-semibold text-muted max-lg:text-sm max-lg:leading-5">
            junk
          </span>
        )}
      </button>
      {expanded && (
        <RegisterParts id={partsId} base={name} value={value} clearedFrom={clearedFrom} />
      )}
    </li>
  )
})
