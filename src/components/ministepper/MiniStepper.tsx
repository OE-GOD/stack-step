import { useId, type ReactNode } from 'react'
import type { EmulatorOptions } from '../../emulator'
import { stepperRoute } from '../../lib/share'
import { WHOLE_PROGRAM_WARNINGS } from '../../features/stepper/problems'
import { ProblemsList } from '../../features/stepper/ProblemsList'
import { useEmulatorSession } from '../../features/stepper/useEmulatorSession'
import {
  callsLibrary,
  CodeListing,
  DataPanel,
  ExplanationPanel,
  FlagsPanel,
  OutputPanel,
  PanelBoundary,
  RegistersPanel,
  registersInProgram,
  StackPanel,
} from '../machine'
import { Button } from '../ui/Button'
import { cx } from '../ui/cx'
import { ArrowRightIcon, ResetIcon, StepBackIcon, StepIcon } from '../ui/icons'
import { TextLink } from '../ui/TextLink'
import type { MiniStepperProps } from './types'

export type { MiniStepperProps } from './types'

/** Narrow widget: icon over the word (like the stepper's phone bar), so three buttons fit. */
const BUTTON_SHAPE =
  '@max-md:min-h-12 @max-md:flex-col @max-md:gap-0.5 @max-md:px-1 @max-md:text-sm'

/** By default the registers the program names, at most this many. */
const MAX_DEFAULT_REGISTERS = 6

/** The options the program runs with: `stdin` is typed into scanf ahead of time. */
function runOptions(options: EmulatorOptions | undefined, stdin: string | undefined) {
  if (stdin === undefined) return options
  return { ...options, stdin }
}

/** Text that changes whenever the program or its starting state changes. */
function programKey({ source, options, stdin }: MiniStepperProps): string {
  return JSON.stringify([source, options ?? null, stdin ?? null], (_key, value: unknown) =>
    typeof value === 'bigint' ? `${value}n` : value,
  )
}

/**
 * A small stepper for lessons and practice: the code, Step / Back / Reset, the chosen
 * registers, optional flags / stack / output / data, and the explanation of the last step.
 * Several can be on one page; each runs its own program.
 *
 * Narrow (a phone, a narrow column): one column, and the explanation comes right after the
 * buttons, so the Step button and what it did are on the screen together. Wide: the code
 * and the buttons on the left, the registers on the right, the explanation at the bottom.
 * On a phone the code shows about 7 lines (the line that runs next stays in sight).
 *
 * A new program (or new options) starts the MiniStepper fresh.
 */
export function MiniStepper(props: MiniStepperProps): ReactNode {
  const key = programKey(props)
  // A crash inside one MiniStepper must not blank the lesson around it.
  return (
    <PanelBoundary title={props.title ?? 'Example program'} resetKey={key} compact>
      <MiniStepperBody key={key} {...props} />
    </PanelBoundary>
  )
}

function MiniStepperBody({
  source,
  options,
  registers,
  showStack = false,
  showFlags = false,
  showOutput,
  showData,
  showRip = false,
  stdin,
  title,
  openInStepper = true,
}: MiniStepperProps): ReactNode {
  const titleId = useId()
  const { state, session } = useEmulatorSession(() => ({
    source,
    options: runOptions(options, stdin),
  }))
  const { machine, program } = state

  const shownRegisters =
    registers ??
    (program === null ? [] : registersInProgram(program).slice(0, MAX_DEFAULT_REGISTERS))
  const wantOutput = showOutput ?? (program !== null && callsLibrary(program))
  const wantData = showData ?? (machine !== null && machine.data.length > 0)
  const canStep = machine !== null && machine.status === 'running'
  const hasSide =
    machine !== null && (shownRegisters.length > 0 || showRip || showFlags || showStack)

  return (
    <section
      aria-labelledby={title === undefined ? undefined : titleId}
      aria-label={title === undefined ? 'Example program' : undefined}
      data-ministepper=""
      className="@container min-w-0 rounded-xl border border-line bg-surface p-3 shadow-xs sm:p-4"
    >
      {(title !== undefined || openInStepper) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {title !== undefined && (
            <h3 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h3>
          )}
          {openInStepper && (
            // 44 px tall to a finger (the padding), without making the row taller.
            <TextLink
              to={stepperRoute({ code: source, options: runOptions(options, stdin) })}
              className="ml-auto -my-3 inline-flex items-center gap-1 py-3 text-sm"
            >
              Open in the stepper
              <ArrowRightIcon size={16} />
            </TextLink>
          )}
        </div>
      )}

      <div
        className={cx('grid gap-3', hasSide && '@2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]')}
      >
        <div className="flex min-w-0 flex-col gap-2.5 @2xl:order-1">
          <CodeListing
            source={source}
            currentLine={machine?.nextLine ?? null}
            libraryLine={machine?.inLibrary?.callLine ?? null}
            libraryName={machine?.inLibrary?.name ?? null}
            label={title === undefined ? 'Code' : `Code: ${title}`}
            // On a phone about 7 lines (24 px each, and the padding), so the Step button and
            // the explanation fit on its screen together; more on a bigger screen.
            className="max-h-[11.25rem] md:max-h-80"
          />
          <ProblemsList diagnostics={state.diagnostics} hideWarnings={WHOLE_PROGRAM_WARNINGS} />
          <div
            role="group"
            aria-label="Run the example"
            className="grid grid-cols-3 gap-2 @md:flex @md:flex-wrap @md:items-center"
          >
            <Button
              variant="primary"
              onClick={() => session.step()}
              disabled={!canStep}
              className={BUTTON_SHAPE}
            >
              <StepIcon size={18} />
              Step
            </Button>
            <Button
              onClick={() => session.back()}
              disabled={!(machine?.canStepBack ?? false)}
              className={BUTTON_SHAPE}
            >
              <StepBackIcon size={18} />
              Back
            </Button>
            <Button
              onClick={() => session.reset()}
              disabled={machine === null || machine.stepCount === 0}
              className={BUTTON_SHAPE}
            >
              <ResetIcon size={18} />
              Reset
            </Button>
          </div>
        </div>

        {/* Narrow: right after the buttons. Wide: under everything, the whole width. */}
        {machine !== null && (
          <ExplanationPanel
            compact
            machine={machine}
            program={program}
            className="rounded-lg bg-surface-2 px-3 py-2.5 @2xl:order-4 @2xl:col-span-full"
          />
        )}

        {hasSide && (
          <div className="flex min-w-0 flex-col gap-3 @2xl:order-2">
            {(shownRegisters.length > 0 || showRip) && (
              <RegistersPanel
                compact
                machine={machine}
                program={program}
                registers={shownRegisters}
                showRip={showRip}
              />
            )}
            {showFlags && <FlagsPanel compact machine={machine} />}
            {showStack && <StackPanel compact machine={machine} listClassName="max-h-72" />}
          </div>
        )}

        {machine !== null && (wantOutput || wantData) && (
          <div className="grid gap-3 @xl:grid-cols-2 @2xl:order-3 @2xl:col-span-full">
            {wantOutput && (
              <OutputPanel
                compact
                machine={machine}
                onSendInput={(text) => session.provideInput(text)}
                textClassName="max-h-40"
              />
            )}
            {wantData && <DataPanel compact machine={machine} />}
          </div>
        )}
      </div>
    </section>
  )
}
