import { memo, type ReactNode } from 'react'
import { LineButton } from '../../components/machine/LineButton'
import { Callout } from '../../components/ui/Callout'
import { cx } from '../../components/ui/cx'
import { WarningIcon } from '../../components/ui/icons'
import { RichText } from '../../components/ui/RichText'
import type { AssembleCode, Diagnostic } from '../../emulator'

export interface ProblemsListProps {
  diagnostics: readonly Diagnostic[]
  /** Leave out these warning codes (see `WHOLE_PROGRAM_WARNINGS` in problems.ts). */
  hideWarnings?: readonly AssembleCode[]
  /**
   * More quiet notes from the page, each about one line, shown with the warnings (a
   * breakpoint that is never reached). Each message starts with "Line N: ".
   */
  notes?: readonly { line: number; message: string }[]
  /**
   * When given, the "Line N" at the start of a message is a button that takes the student
   * to that line in the editor.
   */
  onGoToLine?: (line: number) => void
  className?: string
}

/** One message. Its "Line N:" start becomes a button when the page can go to the line. */
function Message({
  item,
  onGoToLine,
}: {
  item: Pick<Diagnostic, 'line' | 'message'>
  onGoToLine: ((line: number) => void) | undefined
}): ReactNode {
  const prefix = `Line ${item.line}: `
  if (onGoToLine === undefined || item.line < 1 || !item.message.startsWith(prefix)) {
    return <RichText text={item.message} />
  }
  return (
    <>
      <LineButton
        line={item.line}
        title={`Go to line ${item.line} in the code`}
        onClick={onGoToLine}
      >
        Line {item.line}
      </LineButton>
      : <RichText text={item.message.slice(prefix.length)} />
    </>
  )
}

/**
 * Every message of the assembler. Errors stop the program from running, so they come
 * first, in a "wrong" box; warnings follow in a quieter style. Each message already
 * starts with "Line N:" (or is about the whole program).
 *
 * The editor marks lines 1 and up only, so this list is the one place where a message
 * about the whole program (line 0) can be seen. The stepper page shows it in the
 * Explanation card, the MiniStepper under its code.
 */
export const ProblemsList = memo(function ProblemsList({
  diagnostics,
  hideWarnings = [],
  notes = [],
  onGoToLine,
  className,
}: ProblemsListProps): ReactNode {
  const errors = diagnostics.filter((item) => item.severity === 'error')
  const warnings: Pick<Diagnostic, 'line' | 'message'>[] = [
    ...diagnostics.filter(
      (item) => item.severity === 'warning' && !hideWarnings.includes(item.code),
    ),
    ...notes,
  ]
  if (errors.length === 0 && warnings.length === 0) return null
  return (
    <div data-problems="" className={cx('space-y-2', className)}>
      {errors.length > 0 && (
        <Callout
          tone="bad"
          label={
            errors.length === 1
              ? 'Fix this problem to run the program'
              : `Fix these ${errors.length} problems to run the program`
          }
        >
          <ul className="space-y-1 text-[0.9375rem]">
            {errors.map((item, index) => (
              <li key={`${item.line}-${index}`}>
                <Message item={item} onGoToLine={onGoToLine} />
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
          <p className="flex items-center gap-1.5 font-semibold text-warn">
            <WarningIcon size={16} />
            {warnings.length === 1 ? 'Note' : 'Notes'}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {warnings.map((item, index) => (
              <li key={`${item.line}-${index}`}>
                <Message item={item} onGoToLine={onGoToLine} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
})
