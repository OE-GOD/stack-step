import {
  memo,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
} from 'react'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { PauseIcon, PlayIcon, ResetIcon, StepBackIcon, StepIcon } from '../../components/ui/icons'
import { MOD_KEY } from './keys'
import { MAX_SPEED, MIN_SPEED, type SessionState } from './session'
import { StatusLine } from './StatusLine'

/** What the page can ask the controls to do. */
export interface StepperControlsHandle {
  /** Put the keyboard focus on Step (after the scanf box went away, for example). */
  focusStep: () => void
}

export interface StepperControlsProps {
  state: SessionState
  onStep: () => void
  onBack: () => void
  onRunPause: () => void
  onReset: () => void
  onSpeedChange: (speed: number) => void
  /**
   * Narrow screens: slide the bar down out of sight (while the student types in the code
   * or in the input box). It comes back as soon as one of its buttons gets the focus.
   */
  tucked?: boolean
  /** Narrow screens: the height of the fixed bar, whenever it changes (0 on wide screens). */
  onBarHeightChange?: (pixels: number) => void
  className?: string
  ref?: Ref<StepperControlsHandle>
}

function speedText(speed: number): string {
  return speed >= MAX_SPEED ? 'instant' : `${speed} of 10`
}

/**
 * Phone and tablet: icon over the word, as tall as a thumb. Wide: icon beside the word,
 * except when the bar is narrow (1024 px screens): then a small word under the icon, in
 * the same 44 px, so the buttons always fit side by side (a container query on the bar).
 */
const BUTTON_SHAPE =
  'min-w-0 max-lg:min-h-12 max-lg:flex-col max-lg:gap-0.5 max-lg:px-1 max-lg:py-1 max-lg:text-sm lg:px-2.5 lg:@max-[25rem]:flex-col lg:@max-[25rem]:gap-0 lg:@max-[25rem]:px-1 lg:@max-[25rem]:py-1 lg:@max-[25rem]:text-xs'

/** The speed of Run: a labelled slider. Compact on wide screens, thumb-sized on phones. */
function SpeedControl({
  speed,
  onSpeedChange,
  className,
}: {
  speed: number
  onSpeedChange: (speed: number) => void
  className?: string
}): ReactNode {
  const speedId = useId()
  return (
    <div className={cx('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={speedId} className="text-sm font-semibold whitespace-nowrap text-ink">
          Run speed
        </label>
        <span aria-hidden="true" className="text-xs whitespace-nowrap text-muted max-lg:text-sm">
          {speedText(speed)}
        </span>
      </div>
      <input
        id={speedId}
        type="range"
        min={MIN_SPEED}
        max={MAX_SPEED}
        step={1}
        value={speed}
        aria-valuetext={speedText(speed)}
        onChange={(event) => onSpeedChange(Number(event.target.value))}
        className="h-11 w-full cursor-pointer accent-primary lg:h-5"
      />
    </div>
  )
}

/**
 * Step, Back, Run / Pause, Reset and the speed of Run.
 *
 * Wide screens: one row in the left column (the four buttons, then the speed). The status
 * line is in the Explanation card there. Narrow screens: the buttons and the status line
 * are in a bar FIXED to the bottom of the screen (the page leaves room for it, see
 * index.css), and the speed goes to the end of the page (`order-last`). The wrapper is
 * `display: contents` there, so the two parts are placed on their own.
 *
 * A button that cannot act is `aria-disabled`, not `disabled`: a disabled button drops
 * the keyboard focus (it falls back to the page, and a screen reader loses its place).
 * So the focus stays where it is (Step at the end, Back at the start): a student who
 * presses Enter again and again must not set off another button by surprise. Only Reset
 * hands the focus to Step, the next thing to do (harmless if Enter is pressed again).
 */
export const StepperControls = memo(function StepperControls({
  state,
  onStep,
  onBack,
  onRunPause,
  onReset,
  onSpeedChange,
  tucked = false,
  onBarHeightChange,
  className,
  ref,
}: StepperControlsProps): ReactNode {
  const { machine, playing, speed } = state
  const canRun = machine !== null && machine.status === 'running'
  const canBack = machine !== null && machine.canStepBack
  const canReset = machine !== null && (machine.stepCount > 0 || playing)
  const canRunPause = playing || canRun

  const barRef = useRef<HTMLDivElement | null>(null)
  const stepRef = useRef<HTMLButtonElement | null>(null)
  const resetRef = useRef<HTMLButtonElement | null>(null)

  useImperativeHandle(ref, () => ({ focusStep: () => stepRef.current?.focus() }), [])

  // Reset took the program back to the start: the focus goes on to Step.
  useLayoutEffect(() => {
    const step = stepRef.current
    if (!canReset && canRun && step !== null && document.activeElement === resetRef.current) {
      step.focus()
    }
  }, [canReset, canRun])

  // The page needs the height of the fixed bar (to keep room for it, and to keep the line
  // that runs next above it).
  useLayoutEffect(() => {
    const bar = barRef.current
    if (bar === null || onBarHeightChange === undefined) return
    const report = () => {
      const fixed = getComputedStyle(bar).position === 'fixed'
      onBarHeightChange(fixed ? Math.round(bar.getBoundingClientRect().height) : 0)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(bar)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [onBarHeightChange])

  /** A click on a button that cannot act does nothing (it only looks disabled). */
  const guarded = (usable: boolean, action: () => void) => () => {
    if (usable) action()
  }

  return (
    <div className={cx('max-lg:contents lg:flex lg:items-end lg:gap-4', className)}>
      <div
        ref={barRef}
        role="group"
        aria-label="Run the program"
        data-stepper-bar=""
        data-tucked={tucked ? 'true' : undefined}
        className={cx(
          '@container lg:min-w-0 lg:flex-1',
          // Narrow: a bar fixed to the bottom of the screen, as wide as the screen.
          'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:border-t max-lg:border-line max-lg:bg-surface max-lg:px-4 max-lg:pt-1.5 max-lg:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] max-lg:shadow-[0_-4px_14px_rgb(0_0_0/0.08)] max-lg:transition-transform md:max-lg:px-6 print:hidden',
          tucked && 'max-lg:translate-y-full max-lg:focus-within:translate-y-0',
        )}
      >
        <StatusLine state={state} className="mx-auto mb-1 max-w-2xl lg:hidden" />
        <div className="mx-auto grid max-w-2xl grid-cols-4 gap-2 lg:max-w-none">
          <Button
            ref={stepRef}
            variant="primary"
            onClick={guarded(canRun, onStep)}
            aria-disabled={!canRun}
            aria-keyshortcuts={`${MOD_KEY.aria}+Enter S`}
            title={`Step (${MOD_KEY.label} + Enter, or S)`}
            className={BUTTON_SHAPE}
          >
            <StepIcon size={20} />
            Step
          </Button>
          <Button
            onClick={guarded(canBack, onBack)}
            aria-disabled={!canBack}
            aria-keyshortcuts={`${MOD_KEY.aria}+Shift+Enter B`}
            title={`Back (${MOD_KEY.label} + Shift + Enter, or B)`}
            className={BUTTON_SHAPE}
          >
            <StepBackIcon size={20} />
            Back
          </Button>
          <Button
            onClick={guarded(canRunPause, onRunPause)}
            aria-disabled={!canRunPause}
            aria-keyshortcuts={`${MOD_KEY.aria}+Alt+Enter R`}
            title={`${playing ? 'Pause' : 'Run'} (${MOD_KEY.label} + ${MOD_KEY.alt} + Enter, or R)`}
            className={BUTTON_SHAPE}
          >
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
            {playing ? 'Pause' : 'Run'}
          </Button>
          <Button
            ref={resetRef}
            onClick={guarded(canReset, onReset)}
            aria-disabled={!canReset}
            aria-keyshortcuts="0"
            title="Reset (0)"
            className={BUTTON_SHAPE}
          >
            <ResetIcon size={20} />
            Reset
          </Button>
        </div>
      </div>

      <SpeedControl
        speed={speed}
        onSpeedChange={onSpeedChange}
        className="max-lg:order-last max-lg:mt-2 max-lg:max-w-sm lg:w-36 lg:shrink-0 xl:w-40"
      />
    </div>
  )
})
