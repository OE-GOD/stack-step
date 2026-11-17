import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  groupDigits,
  hex,
  type MachineState,
  type Program,
  type RunStopReason,
  type StepNote,
  type StepResult,
} from '../../emulator'
import { Button } from '../ui/Button'
import { Callout } from '../ui/Callout'
import { cx } from '../ui/cx'
import { CheckCircleIcon, InfoIcon, ResetIcon } from '../ui/icons'
import { RichText } from '../ui/RichText'
import { LineButton } from './LineButton'
import { MachinePanel } from './MachinePanel'
import { edgeFade, FOCUS_RING_FOR_CHILD, useScrollEdges } from './useScrollEdges'
import { junkRegisters, readableNumbers, registerList } from './machineView'
import { nextSentence } from './nextText'
import {
  AFTER_ERROR,
  BEFORE_FIRST_STEP,
  fixTheCode,
  keptPlaceSentence,
  PROGRAM_ENDED,
  RESTARTED_BY_EDIT,
} from './words'

export interface ExplanationPanelProps {
  /** null while the program has errors. */
  machine: MachineState | null
  /** For the "Next:" line (the text of the instruction that runs next). */
  program?: Program | null
  /** An edit just started the program again. */
  restartedByEdit?: boolean
  /** An edit did not change what the program does, so the machine stayed at its step. */
  keptPlaceAfterEdit?: boolean
  /** Why the last Run stopped (shown while the program can still go on). */
  runMessage?: string | null
  /** The reason behind `runMessage`: 'step-limit' (a loop that may never end) is a warning. */
  runStop?: RunStopReason | null
  /** Where the input box is, e.g. "The input box is in the Output tab." */
  inputHint?: string
  /** Before the first step: what the program is about (an example's description). */
  intro?: string | null
  /** While the program has errors (no machine): how many, for "Fix the problem(s)…". */
  errorCount?: number
  /**
   * The list of the code's problems (the stepper page puts it here, so the editor above
   * never changes its height when a problem appears while the student types). Shown
   * first while the code has errors, in place of "Fix the problem…"; after the step when
   * there are only warnings.
   */
  problems?: ReactNode
  /** Auto-play is on: the live region stays quiet (the page says once why Run stopped). */
  playing?: boolean
  /** Reset just took the program back to the start from step N: a button goes back there. */
  undoResetTo?: number | null
  onUndoReset?: () => void
  /** Show a line of the code: the line that just ran, the line of an error. */
  onShowLine?: (line: number) => void
  /** The tip of this library step was shown at an earlier step: a short reminder is enough. */
  repeatedTip?: boolean
  /**
   * Shown under the warning of a `scanf` that could not read the typed text, when Back
   * gives the input back (the stepper page): "Press Back to type it again."
   */
  retryInputHint?: string | null
  /** Smaller text, no card (MiniStepper). */
  compact?: boolean
  title?: string
  /**
   * The explanation scrolls inside a box (back to the top on every step, with a fade
   * where more text is hidden), and the "Next:" line stays under it. The box takes the
   * height left in the card; give it a height for narrow screens with `textClassName`.
   * Narrow screens also drop the heading bar (it stays for screen readers).
   */
  scrolls?: boolean
  /** Classes for the scrolling box (its height on narrow screens). */
  textClassName?: string
  /** Shown at the right of the heading (full size only), e.g. the status of the program. */
  actions?: ReactNode
  className?: string
}

/** The "Line N" at the start of a message, as a button that shows that line of code. */
function LineMessage({
  text,
  line,
  onShowLine,
}: {
  text: string
  line: number | null
  onShowLine: ((line: number) => void) | undefined
}): ReactNode {
  const prefix = line === null ? null : `Line ${line}: `
  if (line === null || prefix === null || onShowLine === undefined || !text.startsWith(prefix)) {
    return <RichText text={readableNumbers(text)} />
  }
  return (
    <>
      <LineButton line={line} title={`Show line ${line} in the code`} onClick={onShowLine}>
        Line {line}
      </LineButton>
      : <RichText text={readableNumbers(text.slice(prefix.length))} />
    </>
  )
}

/** "Step 4 · ran line 13", where "line 13" shows the line in the code. */
function StepHeading({
  step,
  onShowLine,
}: {
  step: StepResult
  onShowLine: ((line: number) => void) | undefined
}): ReactNode {
  const line =
    onShowLine === undefined ? (
      `line ${step.line}`
    ) : (
      <LineButton
        line={step.line}
        title={`Show line ${step.line} in the code`}
        onClick={onShowLine}
      >
        line {step.line}
      </LineButton>
    )
  return (
    <p data-step-heading="" className="text-xs font-semibold text-muted max-lg:text-sm">
      Step {groupDigits(step.stepNumber)} ·{' '}
      {step.kind === 'library' ? (
        <>
          ran {step.text}, called on {line}
        </>
      ) : (
        <>ran {line}</>
      )}
    </p>
  )
}

/** The text of a note; a tip about junk registers that was shown before becomes one line. */
function noteText(note: StepNote, step: StepResult, repeatedTip: boolean): string {
  if (!repeatedTip || note.kind !== 'tip' || step.kind !== 'library') return note.text
  const junk = junkRegisters(step)
  if (junk.size === 0) return note.text
  return `${registerList(junk)} ${junk.size === 1 ? 'holds' : 'hold'} junk now.`
}

/** A `scanf` step with a warning: it could not read (all of) the text that was typed. */
function readFailed(step: StepResult): boolean {
  return step.kind === 'library' && step.text.startsWith('scanf')
}

/** "0x…dff8" in an explanation: the end of an address. */
const SHORT_ADDRESS = /0x…([0-9a-f]+)/

/**
 * The full address behind the short form `0x…dff8` of an explanation, found among the
 * addresses the machine shows (the stack boxes, rsp, rbp); null when none matches.
 */
function fullAddress(short: string, machine: MachineState): string | null {
  const ending = SHORT_ADDRESS.exec(short)?.[1]
  if (ending === undefined) return null
  const candidates = [
    machine.registers.rsp,
    machine.registers.rbp,
    ...(machine.lastStep?.diff.registers.flatMap((change) => [change.before, change.after]) ?? []),
    ...machine.stack.slice(0, 64).map((slot) => slot.address),
  ]
  const match = candidates.find((value) => value.toString(16).endsWith(ending))
  return match === undefined ? null : hex(match)
}

/**
 * The first step on the screen whose explanation shortens an address (`0x…dff8`). That
 * step gets one extra line that says what the short form means.
 */
function useShortFormStep(step: StepResult | null): StepResult | null {
  const [first, setFirst] = useState<StepResult | null>(null)
  if (first === null && step !== null && SHORT_ADDRESS.test(step.explanation)) {
    setFirst(step)
    return step
  }
  return first
}

/**
 * What the last step did, in plain words, with its tips and warnings; an error or the end
 * of the program; and one quiet line that says what runs next.
 * The explanation is a polite live region: screen readers read each new step.
 * Memoised (pass stable callbacks and elements).
 */
export const ExplanationPanel = memo(function ExplanationPanel({
  machine,
  program = null,
  restartedByEdit = false,
  keptPlaceAfterEdit = false,
  runMessage = null,
  runStop = null,
  inputHint,
  intro = null,
  errorCount = 1,
  problems,
  playing = false,
  undoResetTo = null,
  onUndoReset,
  onShowLine,
  repeatedTip = false,
  retryInputHint = null,
  compact = false,
  title = 'Explanation',
  scrolls = false,
  textClassName,
  actions,
  className,
}: ExplanationPanelProps): ReactNode {
  const step = machine?.lastStep ?? null
  const next = machine === null ? null : nextSentence(machine, program)
  const status = machine?.status ?? null
  const textSize = compact ? 'text-sm' : 'text-base'
  // Breakpoints and the endless-loop guard: the program could go on, so say why it stopped.
  const showRunMessage = runMessage !== null && status === 'running'
  const calloutSize = compact ? 'px-3 py-2 text-sm' : 'px-3.5 py-2.5'
  const noteClass = compact ? 'text-sm' : 'text-[0.9375rem] leading-snug'
  const shortFormStep = useShortFormStep(step)
  const shortForm =
    machine !== null && step !== null && step === shortFormStep
      ? (SHORT_ADDRESS.exec(step.explanation)?.[0] ?? null)
      : null
  const shortFull = shortForm === null || machine === null ? null : fullAddress(shortForm, machine)

  // The scrolling part: back to the top for every new step, and a fade at an edge that
  // hides more text. When it hides text, the keyboard can reach it (to scroll it).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [step])
  const edges = useScrollEdges(scrollRef, scrolls, step)
  const hidesText = edges.above || edges.below

  return (
    <MachinePanel
      title={title}
      compact={compact}
      fill={scrolls}
      actions={actions}
      className={cx(
        scrolls &&
          'max-lg:[&>div:first-child]:sr-only max-lg:[&>div:last-child]:px-3.5 max-lg:[&>div:last-child]:py-2.5',
        className,
      )}
    >
      {/* The frame draws the focus outline of the box inside it (the fade would hide it). */}
      <div className={cx(scrolls && 'flex min-h-0 flex-1 flex-col', FOCUS_RING_FOR_CHILD)}>
        <div
          ref={scrollRef}
          data-explanation-text=""
          // A box that scrolls must be reachable with the keyboard, or keyboard users
          // (Safari does not make scrolling boxes focusable by itself) cannot read the rest.
          tabIndex={scrolls && hidesText ? 0 : undefined}
          role={scrolls && hidesText ? 'group' : undefined}
          aria-label={scrolls && hidesText ? 'Explanation of the step (scrolls)' : undefined}
          className={cx(
            scrolls &&
              'min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none lg:-mr-2 lg:pr-2',
            scrolls && textClassName,
            edgeFade(edges),
          )}
        >
          {/* The list of problems is outside the live region: it changes while the student
            types, and a screen reader would read it again each time. */}
          {machine === null && problems !== undefined && (
            <div className="mb-2.5 empty:hidden">{problems}</div>
          )}
          <div aria-live={playing ? 'off' : 'polite'} className={cx('space-y-2.5', textSize)}>
            {restartedByEdit && machine !== null && (
              <p className="flex items-start gap-1.5 text-sm text-muted">
                <InfoIcon size={16} className="mt-0.5 shrink-0" />
                {RESTARTED_BY_EDIT}
              </p>
            )}
            {keptPlaceAfterEdit && machine !== null && (
              <p className="flex items-start gap-1.5 text-sm text-muted">
                <InfoIcon size={16} className="mt-0.5 shrink-0" />
                {keptPlaceSentence(machine.stepCount)}
              </p>
            )}
            {machine !== null && undoResetTo !== null && onUndoReset !== undefined && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                The program is back at the start.
                <Button
                  size="sm"
                  onClick={onUndoReset}
                  className="pointer-coarse:min-h-11"
                  data-undo-reset=""
                >
                  <ResetIcon size={16} className="-scale-x-100" />
                  Undo: back to step {undoResetTo}
                </Button>
              </p>
            )}

            {machine === null && (
              // Said once when the code stops being runnable; the list itself is above.
              <p className={problems === undefined ? 'text-ink' : 'sr-only'}>
                {fixTheCode(errorCount)}
              </p>
            )}

            {/* What stopped the program comes first: it matters most, and stays in view. */}
            {status === 'error' && machine?.error && (
              <Callout tone="bad" label="Error" className={calloutSize}>
                <p className={noteClass}>
                  <LineMessage
                    text={machine.error.message}
                    line={machine.error.line}
                    onShowLine={onShowLine}
                  />
                </p>
                {!compact && <p className={cx(noteClass, 'text-muted')}>{AFTER_ERROR}</p>}
              </Callout>
            )}
            {status === 'waiting-input' && machine?.inputRequest && (
              <Callout tone="info" label="Waiting for input" className={calloutSize}>
                <p className={noteClass}>
                  {machine.inputRequest.prompt}
                  {inputHint !== undefined && ` ${inputHint}`}
                </p>
              </Callout>
            )}
            {status === 'halted' && (
              <p className="flex items-center gap-2 font-semibold text-good">
                <CheckCircleIcon size={20} />
                <span>
                  {PROGRAM_ENDED}{' '}
                  <span className="font-normal text-muted">Press Reset to run it again.</span>
                </span>
              </p>
            )}
            {showRunMessage &&
              (runStop === 'step-limit' ? (
                <Callout tone="warn" label="Stopped" className={calloutSize}>
                  <p className={noteClass}>{runMessage}</p>
                </Callout>
              ) : (
                <p className="flex items-start gap-1.5 text-sm font-semibold text-ink">
                  <InfoIcon size={16} className="mt-0.5 shrink-0 text-primary" />
                  {runMessage}
                </p>
              ))}

            {machine !== null && step === null && (
              <>
                {intro !== null && <p className="text-pretty text-ink">{intro}</p>}
                <p className="text-muted">{BEFORE_FIRST_STEP}</p>
              </>
            )}
            {step !== null && (
              <div>
                <StepHeading step={step} onShowLine={onShowLine} />
                <p className="mt-0.5 leading-relaxed text-pretty text-ink">
                  <RichText text={readableNumbers(step.explanation)} />
                </p>
              </div>
            )}
            {step?.notes.map((note, index) => (
              <Callout
                key={`${step.stepNumber}-${index}`}
                tone={note.kind === 'tip' ? 'info' : 'warn'}
                label={note.kind === 'tip' ? 'Tip' : 'Warning'}
                className={calloutSize}
              >
                <p className={noteClass}>
                  <RichText text={readableNumbers(noteText(note, step, repeatedTip))} />
                </p>
                {retryInputHint !== null && note.kind === 'warning' && readFailed(step) && (
                  <p className={cx(noteClass, 'font-semibold')}>{retryInputHint}</p>
                )}
              </Callout>
            ))}
            {shortForm !== null && !compact && (
              <p className="text-sm text-muted">
                <span className="font-mono">{readableNumbers(shortForm)}</span> is a short way to
                write a long address: the start is left out.
                {shortFull !== null && (
                  <>
                    {' '}
                    Here it is <span className="font-mono">{shortFull}</span>.
                  </>
                )}
              </p>
            )}
          </div>
          {machine !== null && problems !== undefined && (
            <div className="mt-2.5 empty:hidden">{problems}</div>
          )}
        </div>
      </div>

      {next !== null && (
        <p
          data-next-line=""
          className={cx(
            'mt-2.5 shrink-0 border-t border-line pt-2 text-muted',
            // Narrow screens: 14 px, the code in it too (code is 0.9em elsewhere).
            compact ? 'text-xs max-lg:text-sm' : 'text-sm',
            'max-lg:[&_code]:text-[1em]',
            // Narrow screens: one line, so the card never changes its height.
            scrolls && 'max-lg:mt-2 max-lg:truncate max-lg:pt-1.5',
          )}
        >
          <RichText text={next} />
        </p>
      )}
    </MachinePanel>
  )
})
