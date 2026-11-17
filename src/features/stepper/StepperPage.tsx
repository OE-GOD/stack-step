/**
 * The stepper: the student writes or pastes a short program, presses Step, and sees what
 * every register, the stack, rsp, rip and the flags do.
 *
 * Layout
 * - 1024 px and wider: three columns, all on screen at once (no page scroll down to
 *   1366×655, a Chromebook with its browser bars):
 *   [toolbar, code, controls, explanation] · [registers with the flags] · [stack, output].
 *   The editor has a height that grows with the screen; the Explanation card takes what
 *   is left, and never less than room for a whole step (4 lines and a tip).
 * - Narrower: one column: toolbar, code (as tall as the screen allows), the explanation
 *   (a box of fixed height, so nothing under it moves from step to step), the tabs
 *   (Registers · Stack · Output), and the speed of Run at the end. The four buttons are
 *   in a bar FIXED to the bottom of the screen; the page keeps room for it (index.css).
 *
 * Where the program comes from, typing, saving and examples: useWorkspaceProgram.ts.
 * A new `?s=` or `?example=` while the page is open starts a fresh workspace (the page
 * itself is not remounted when only the query changes).
 *
 * `?demo=ministepper` adds MiniSteppers under the stepper (a reference for lessons).
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { ExplanationPanel, PanelBoundary } from '../../components/machine'
import { Callout } from '../../components/ui/Callout'
import { CloseIcon, WarningIcon } from '../../components/ui/icons'
import { IconButton } from '../../components/ui/IconButton'
import { RichText } from '../../components/ui/RichText'
import { useRoute } from '../../lib/router'
import { loadText, removeKey, saveText } from '../../lib/storage'
import { isTutorKnownEnabled, whenTutorEnabled } from '../tutor/availability'
import { TutorMount } from '../tutor/TutorMount'
import { EditorSlot } from './EditorSlot'
import type { CodeEditorHandle } from './editor/types'
import { exampleWithSource, SINGLE_KEYS_STORAGE_KEY, type ProgramQuery } from './initialProgram'
import { summarizeMachine } from './machineSummary'
import { MiniStepperDemo } from './MiniStepperDemo'
import { unreachedBreakpoints, WHOLE_PROGRAM_WARNINGS } from './problems'
import { ProblemsList } from './ProblemsList'
import type { SessionState } from './session'
import { statusOf, stepsText } from './status'
import { StatusLine } from './StatusLine'
import { StepperControls, type StepperControlsHandle } from './StepperControls'
import { StepperPanels } from './StepperPanels'
import { StepperToolbar } from './StepperToolbar'
import { TOUCH_SCREEN, useMediaQuery, WIDE_LAYOUT } from './useMediaQuery'
import { useStepperShortcuts } from './useStepperShortcuts'
import { useWorkspaceProgram } from './useWorkspaceProgram'

/** Shown under the warning of a scanf that could not read the typed text. */
const RETRY_INPUT = 'Press Back to type it again.'
/** Shown with an example that was loaded over the student's own program. */
const OWN_PROGRAM_KEPT =
  'Your own program is kept: choose “Your own program” in the Example menu to get it back.'
/** Shown when a link's program, changed by the student, took the place of their program. */
const EARLIER_PROGRAM_KEPT =
  'Your earlier program is kept: choose “Your earlier program” in the Example menu to get it back.'
/** Shown above the code when the browser does not let the page save (blocked or full storage). */
const CANNOT_SAVE =
  'This browser does not let Stack Step save your program. Copy it before you close or reload this page.'

/**
 * The room the tutor's button needs at the end of a narrow page and at the bottom of the
 * right column of a wide one: the button (48 px on a phone, 44 px wider up) and its gap.
 */
const TUTOR_ROOM_PX = 64

export default function StepperPage(): ReactNode {
  const { query } = useRoute()
  const s = query.get('s')
  const example = query.get('example')
  // A new link starts a fresh workspace. An address without a link (the page dropped the
  // link after the first edit, or the student clicked "Stepper" in the menu) keeps the
  // workspace as it is. The same link again later is new again.
  const link = s === null && example === null ? null : `${s ?? ''}|${example ?? ''}`
  const [workspace, setWorkspace] = useState({ link, key: 0 })
  if (link !== workspace.link) {
    setWorkspace({ link, key: link === null ? workspace.key : workspace.key + 1 })
  }
  return (
    <>
      <StepperWorkspace key={workspace.key} s={s} example={example} />
      {query.get('demo') === 'ministepper' && <MiniStepperDemo />}
    </>
  )
}

/** True for an element that takes typed text (the on-screen keyboard is open for it). */
function typesText(element: Element | null): boolean {
  if (element === null) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return (
    element.closest(
      'textarea, .cm-editor, input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"], [type="submit"])',
    ) !== null
  )
}

/** True while the keyboard focus is in something that takes typed text. */
function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const update = () => setTyping(typesText(document.activeElement))
    // During `focusout` the focus is nowhere yet: look once it has arrived.
    const later = () => window.setTimeout(update, 0)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', later)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', later)
    }
  }, [])
  return typing
}

/**
 * Below this visible height (in px) a touch screen is short: its on-screen keyboard is
 * open (the screen above the keyboard is left), or the phone is held sideways.
 */
const SHORT_SCREEN = 520

/** The height of the part of the page that is visible (above an on-screen keyboard). */
function useVisibleHeight(): number {
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? 0 : (window.visualViewport?.height ?? window.innerHeight),
  )
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => setHeight(viewport?.height ?? window.innerHeight)
    const target = viewport ?? window
    target.addEventListener('resize', update)
    return () => target.removeEventListener('resize', update)
  }, [])
  return height
}

/**
 * True once the optional tutor is known to be on: its button then sits at the bottom right
 * of the screen, and the page keeps room for it. (The same one question as TutorMount's.)
 */
function useTutorOn(): boolean {
  const [on, setOn] = useState(isTutorKnownEnabled)
  useEffect(() => {
    if (on) return
    let mounted = true
    void whenTutorEnabled().then((answer) => {
      if (mounted && answer) setOn(true)
    })
    return () => {
      mounted = false
    }
  }, [on])
  return on
}

/** The height of an element in px (0 while it is hidden), kept up to date. */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setHeight(Math.round(element.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/** The single-key shortcuts (S, B, R, 0): on unless the student switched them off. */
function useSingleKeys(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => loadText(SINGLE_KEYS_STORAGE_KEY) !== 'off')
  const change = useCallback((next: boolean) => {
    setOn(next)
    if (next) removeKey(SINGLE_KEYS_STORAGE_KEY)
    else saveText(SINGLE_KEYS_STORAGE_KEY, 'off')
  }, [])
  return [on, change]
}

/**
 * One sentence for screen readers when Run stops by itself or is paused ("Paused at line
 * 22 (breakpoint), 13 steps."). While Run plays, the explanation is quiet (it would read
 * every step), so this says once where it stopped.
 */
function useRunStopAnnouncement(state: SessionState): string {
  const [seen, setSeen] = useState({ playing: state.playing, text: '' })
  if (state.playing !== seen.playing) {
    const steps = state.machine === null ? '' : `, ${stepsText(state.machine.stepCount)}`
    const text = state.playing ? '' : `${statusOf(state).text}${steps}.`
    setSeen({ playing: state.playing, text })
    return text
  }
  return seen.text
}

function StepperWorkspace({ s, example }: ProgramQuery): ReactNode {
  const workspace = useWorkspaceProgram({ s, example })
  const { state, session, flushEdits } = workspace
  const { machine, program } = state
  const wide = useMediaQuery(WIDE_LAYOUT)
  const touch = useMediaQuery(TOUCH_SCREEN)
  const typing = useTypingFocus()
  const visibleHeight = useVisibleHeight()
  const [singleKeys, setSingleKeys] = useSingleKeys()
  const [barHeight, setBarHeight] = useState(0)
  const tutorOn = useTutorOn()
  const editorRef = useRef<CodeEditorHandle | null>(null)
  const controlsRef = useRef<StepperControlsHandle | null>(null)
  const aboveCodeRef = useRef<HTMLDivElement | null>(null)
  const aboveCode = useHeight(aboveCodeRef)
  const codeHeadingId = useId()
  const runStopped = useRunStopAnnouncement(state)

  // The fixed bar of a narrow screen: the page keeps that much room at its end (see
  // index.css), and the tutor's button sits above it. With the tutor, the room is taller
  // by the button, so the footer and the last control can scroll out from under it, and
  // whatever the browser scrolls into view stops above it too.
  const endRoom = barHeight > 0 && tutorOn ? barHeight + TUTOR_ROOM_PX : barHeight
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--stepper-bar-height', `${endRoom}px`)
    return () => {
      root.style.removeProperty('--stepper-bar-height')
    }
  }, [endRoom])

  // Every control first takes in an edit that is still waiting, so Step right after
  // typing runs the new program. The callbacks are stable, so the memoised editor,
  // toolbar and controls do not render again because of them.
  const step = useCallback(() => {
    flushEdits()
    session.step()
  }, [flushEdits, session])
  const back = useCallback(() => {
    flushEdits()
    session.back()
  }, [flushEdits, session])
  const toggleRun = useCallback(() => {
    flushEdits()
    if (session.getState().playing) session.pause()
    else session.play()
  }, [flushEdits, session])
  const reset = useCallback(() => {
    flushEdits()
    session.reset()
  }, [flushEdits, session])
  const undoReset = useCallback(() => session.undoReset(), [session])
  useStepperShortcuts({ step, back, toggleRun, reset, singleKeys })

  // Breakpoint lines belong to the text in the editor: the program takes that text first.
  const toggleBreakpoint = useCallback(
    (line: number) => {
      flushEdits()
      session.toggleBreakpoint(line)
    },
    [flushEdits, session],
  )
  // An edit moved breakpoints with their lines (a line added above one).
  const moveBreakpoints = useCallback(
    (lines: number[]) => {
      flushEdits()
      session.setBreakpoints(lines)
    },
    [flushEdits, session],
  )

  const sendInput = useCallback(
    (text: string) => {
      flushEdits()
      session.provideInput(text)
      // The input box goes away: the keyboard focus goes on to Step, not to the page.
      if (session.getState().machine?.status !== 'waiting-input') controlsRef.current?.focusStep()
    },
    [flushEdits, session],
  )

  const goToLine = useCallback((line: number) => editorRef.current?.goToLine(line), [])
  const showLine = useCallback((line: number) => editorRef.current?.showLine(line), [])

  // The line that just ran (the step the Explanation talks about), and a run-time error.
  const lastStep = machine?.lastStep ?? null
  const lastLine = lastStep !== null && lastStep.executed ? lastStep.line : null
  const error = machine?.status === 'error' ? machine.error : null
  const runtimeError = useMemo(
    () =>
      error === null || error.line === null ? null : { line: error.line, message: error.message },
    [error],
  )

  // A practice problem's code is shown exactly as the problem wrote it (the program of a
  // link with a note): the notes about whole programs (no `main:`, no `.intel_syntax`) are
  // noise there.
  const hideWarnings = workspace.note !== null ? WHOLE_PROGRAM_WARNINGS : undefined
  // A breakpoint on a line without an instruction (a comment, a label at the end) is never
  // reached: say so, quietly.
  const breakpointNotes = useMemo(
    () => unreachedBreakpoints(program, state.breakpoints),
    [program, state.breakpoints],
  )
  // Elements for the memoised Explanation card: new only when what they show changes.
  const problems = useMemo(
    () => (
      <ProblemsList
        diagnostics={state.diagnostics}
        hideWarnings={hideWarnings}
        notes={breakpointNotes}
        onGoToLine={goToLine}
      />
    ),
    [state.diagnostics, hideWarnings, breakpointNotes, goToLine],
  )
  const statusLine = useMemo(() => <StatusLine state={state} className="max-lg:hidden" />, [state])

  const status = statusOf(state)
  const errorCount = state.diagnostics.filter((item) => item.severity === 'error').length
  const description = exampleWithSource(state.source)?.description ?? null
  const kept = workspace.keptNotice?.kind ?? null
  const intro =
    kept === 'link'
      ? EARLIER_PROGRAM_KEPT
      : description !== null && kept === 'example'
        ? `${description} ${OWN_PROGRAM_KEPT}`
        : description

  const pageStyle = {
    '--tutor-bottom-offset': `${wide ? 0 : barHeight}px`,
    // The note above the code (and the other lines there) take their whole height on a
    // wide screen: the Explanation card gives up that much of its least height.
    '--stepper-above-code': `${aboveCode > 0 ? aboveCode + 8 : 0}px`,
  } as CSSProperties

  return (
    <div
      data-stepper-page=""
      data-status={status.kind}
      data-steps={machine?.stepCount ?? 0}
      data-edit-pending={workspace.editPending ? 'true' : undefined}
      style={pageStyle}
      className="mx-auto w-full max-w-[100rem] px-4 pt-3 pb-4 md:px-6 md:pt-4 lg:flex lg:h-[calc(100dvh-4rem-1px)] lg:min-h-[34rem] lg:flex-col lg:py-4"
    >
      <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.75fr)_18.5rem_minmax(17.5rem,0.9fr)] lg:gap-x-4">
        {/*
          The left column. Wide: a column of its own. Narrow: `contents`, so its parts are
          placed one by one in the page's grid.
        */}
        <div className="max-lg:contents lg:flex lg:min-h-0 lg:min-w-0 lg:flex-col lg:gap-3">
          <PanelBoundary title="Stepper">
            <StepperToolbar
              source={state.source}
              linkProgram={workspace.linkProgram}
              hasOtherProgram={workspace.hasOtherProgram}
              getProgram={workspace.getProgram}
              onChooseExample={workspace.chooseExample}
              singleKeys={singleKeys}
              onSingleKeysChange={setSingleKeys}
            />
          </PanelBoundary>

          <section
            aria-labelledby={codeHeadingId}
            className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:shrink lg:overflow-hidden"
          >
            <h2 id={codeHeadingId} className="sr-only">
              Code
            </h2>
            {/*
              What is said about the code, above it: a link's note, a link that could not be
              used, storage that does not work. Each line keeps its whole height (the editor
              and the Explanation card give up room instead), so nothing is cut off.
            */}
            <div
              ref={aboveCodeRef}
              data-above-code=""
              className="flex flex-col gap-2 empty:hidden lg:shrink-0"
            >
              {workspace.note !== null && (
                <Callout tone="info" label="Note" data-link-note="">
                  <p>
                    <RichText text={workspace.note} />
                  </p>
                </Callout>
              )}
              {workspace.notice !== null && (
                <div className="flex items-start gap-1">
                  <Callout tone="warn" label="Link problem" className="min-w-0 flex-1">
                    <p>{workspace.notice}</p>
                  </Callout>
                  <IconButton label="Close the message" onClick={workspace.dismissNotice}>
                    <CloseIcon />
                  </IconButton>
                </div>
              )}
              {workspace.cannotSave && (
                <p data-cannot-save="" className="flex items-start gap-1.5 text-sm text-muted">
                  <WarningIcon size={16} className="mt-0.5 shrink-0 text-warn" />
                  {CANNOT_SAVE}
                </p>
              )}
            </div>
            {/*
              The editor's height. Narrow: what the screen leaves after the toolbar, the
              explanation, the tabs and the bar (small view height, so it does not change
              while a phone's address bar comes and goes), from 10rem to 24rem. Wide: it
              grows with the screen, and shrinks only when the column is overfull.
            */}
            <div className="h-[clamp(10rem,calc(100svh-34rem),24rem)] min-h-0 overflow-hidden rounded-xl border border-line-strong/70 bg-code-bg shadow-xs lg:h-auto lg:min-h-[9rem] lg:flex-[0_1_clamp(9rem,calc(100dvh-32rem),44rem)]">
              <EditorSlot
                ref={editorRef}
                value={workspace.code}
                onChange={workspace.onEdit}
                currentLine={machine?.nextLine ?? null}
                lastLine={lastLine}
                libraryLine={machine?.inLibrary?.callLine ?? null}
                libraryName={machine?.inLibrary?.name ?? null}
                breakpoints={state.breakpoints}
                onToggleBreakpoint={toggleBreakpoint}
                onBreakpointsChange={moveBreakpoints}
                diagnostics={state.diagnostics}
                runtimeError={runtimeError}
                wrapLines={wide}
                coveredBottom={wide ? 0 : barHeight}
                ariaLabel="Assembly code"
              />
            </div>
          </section>

          <PanelBoundary title="Controls">
            <StepperControls
              ref={controlsRef}
              state={state}
              onStep={step}
              onBack={back}
              onRunPause={toggleRun}
              onReset={reset}
              onSpeedChange={workspace.changeSpeed}
              // A phone with its keyboard open (or held sideways): the bar slides away
              // while the student types, so it covers neither the code nor the input box.
              tucked={touch && typing && visibleHeight < SHORT_SCREEN}
              onBarHeightChange={setBarHeight}
            />
          </PanelBoundary>

          <PanelBoundary title="Explanation" resetKey={state}>
            <ExplanationPanel
              machine={machine}
              program={program}
              restartedByEdit={state.restartedByEdit}
              keptPlaceAfterEdit={state.keptPlaceAfterEdit}
              runMessage={state.runMessage}
              runStop={state.runStop}
              inputHint={
                wide
                  ? 'The input box is in Output, on the right.'
                  : 'The input box is in the Output tab.'
              }
              intro={intro}
              errorCount={errorCount}
              // The code's problems are listed here, not under the editor: the editor keeps
              // its height when a problem appears while the student types.
              problems={problems}
              playing={state.playing}
              undoResetTo={state.undoResetTo}
              onUndoReset={undoReset}
              onShowLine={showLine}
              repeatedTip={state.repeatedTip}
              retryInputHint={RETRY_INPUT}
              scrolls
              // Narrow: a box of fixed height, so the tabs under it never move.
              textClassName="max-lg:h-[8.5rem] max-lg:flex-none"
              actions={statusLine}
              // Wide: the height that is left in the column, at least room for a whole step
              // (less on a short screen, where the editor needs its 9 lines too, and less by
              // the lines above the code).
              className="lg:min-h-[min(19.5rem,calc(100dvh-27rem-var(--stepper-above-code,0px)))] lg:flex-1"
            />
          </PanelBoundary>
        </div>

        <StepperPanels state={state} wide={wide} roomForTutor={tutorOn} onSendInput={sendInput} />
      </div>

      {/* Said once when Run stops (the explanation is quiet while Run plays). */}
      <p role="status" className="sr-only">
        {runStopped}
      </p>

      <TutorMount
        getContext={() => ({
          page: 'stepper',
          code: workspace.code,
          machine: summarizeMachine(machine, { diagnostics: state.diagnostics, program }),
          problem: null,
        })}
      />
    </div>
  )
}
