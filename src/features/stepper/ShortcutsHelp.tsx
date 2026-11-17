import { useId, type ReactNode } from 'react'
import { cx } from '../../components/ui/cx'
import { KeyboardIcon } from '../../components/ui/icons'
import { Kbd } from '../../components/ui/Kbd'
import { Popover } from '../../components/ui/Popover'
import { MOD_KEY } from './keys'

/** Keys joined with "+": <Keys keys={['Ctrl', 'Enter']} />. */
function Keys({ keys }: { keys: readonly string[] }): ReactNode {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {keys.map((key, index) => (
        <span key={key} className="inline-flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">+</span>}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  )
}

const ROWS: readonly { action: string; keys: readonly string[]; single: string | null }[] = [
  { action: 'Step', keys: [MOD_KEY.label, 'Enter'], single: 'S' },
  { action: 'Back', keys: [MOD_KEY.label, 'Shift', 'Enter'], single: 'B' },
  { action: 'Run / Pause', keys: [MOD_KEY.label, MOD_KEY.alt, 'Enter'], single: 'R' },
  { action: 'Reset', keys: [], single: '0' },
]

export interface ShortcutsHelpProps {
  /** The single keys S, B, R and 0 work (the student can switch them off here). */
  singleKeys: boolean
  onSingleKeysChange: (on: boolean) => void
  className?: string
  /** Classes for the word on the button (hide it where there is no room). */
  labelClassName?: string
}

/**
 * The "Keys" button and its panel: the keys of the stepper, breakpoints, leaving the
 * editor, and a switch for the single-key shortcuts. Not shown when the main pointer is a
 * finger (a phone has no Ctrl or Option key).
 */
export function ShortcutsHelp({
  singleKeys,
  onSingleKeysChange,
  className,
  labelClassName,
}: ShortcutsHelpProps): ReactNode {
  const switchId = useId()
  return (
    <Popover
      button={
        <>
          <KeyboardIcon size={20} />
          <span className={labelClassName}>Keys</span>
        </>
      }
      buttonLabel="Keys (keyboard shortcuts)"
      buttonVariant="ghost"
      buttonClassName="px-2.5"
      title="Keyboard shortcuts"
      align="end"
      panelClassName="w-[21rem]"
      className={cx('pointer-coarse:hidden', className)}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Keys for the controls</caption>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.action} className="align-top">
              <th scope="row" className="py-1 pr-3 text-left font-semibold whitespace-nowrap">
                {row.action}
              </th>
              <td className="py-1">
                <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  {row.keys.length > 0 && <Keys keys={row.keys} />}
                  {row.keys.length > 0 && row.single !== null && (
                    <span className={cx('text-muted', !singleKeys && 'line-through')}>or</span>
                  )}
                  {row.single !== null && (
                    <span className={cx(!singleKeys && 'line-through opacity-60')}>
                      <Kbd>{row.single}</Kbd>
                    </span>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-muted">
        The keys with <Kbd>{MOD_KEY.label}</Kbd> work everywhere. The single keys work when the
        cursor is not in the code.
      </p>
      <p className="mt-2 flex items-start gap-2 text-sm">
        <input
          id={switchId}
          type="checkbox"
          checked={singleKeys}
          onChange={(event) => onSingleKeysChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
        />
        <label htmlFor={switchId} className="cursor-pointer">
          Use the single keys (S, B, R, 0)
        </label>
      </p>
      <p className="mt-3 text-sm">
        <span className="font-semibold">Breakpoint:</span> click a line number. In the code you can
        also press <Keys keys={[MOD_KEY.label, 'B']} />.
      </p>
      <p className="mt-2 text-sm">
        <span className="font-semibold">Leave the code with the keyboard:</span> press{' '}
        <Kbd>Esc</Kbd>, then <Kbd>Tab</Kbd>.
      </p>
    </Popover>
  )
}
