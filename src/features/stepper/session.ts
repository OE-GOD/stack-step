/**
 * The stepper session: one program, one emulator, auto-play, breakpoints and input.
 *
 * Plain TypeScript (no React), so the stepper page, every MiniStepper and the unit tests
 * drive the same object:
 *
 *   const session = new StepperSession({ source })
 *   const stop = session.subscribe(() => draw(session.getState()))
 *   session.step()
 *
 * - `getState()` returns the same object until something changes, so it fits React's
 *   `useSyncExternalStore` (see useEmulatorSession.ts).
 * - `setSource` re-assembles at once. The page waits until the student stops typing.
 *   An edit that does not change what the program does (a comment, spaces) keeps the
 *   machine where it was; any other edit starts the program again from the top.
 * - Breakpoints belong to the session, not to one emulator: they survive edits. Lines
 *   that no longer exist are dropped.
 * - Auto-play is a chain of `setTimeout` calls (never `setInterval`). The timer functions
 *   can be injected, so tests can drive the clock.
 * - The emulator is deterministic, so any place in a run can be built again from the
 *   start: run the same number of steps and give scanf the same typed text at the same
 *   moments (`replay`). Undo after Reset, Back over a step that read typed input, and an
 *   edit that keeps the place all work this way.
 */
import {
  createEmulator,
  DEFAULT_OPTIONS,
  runStopMessage,
  type Diagnostic,
  type Emulator,
  type EmulatorOptions,
  type MachineState,
  type Operand,
  type Program,
  type RunStopReason,
} from '../../emulator'

/* ──────────────────────────────── Speed ──────────────────────────────── */

/** The slowest auto-play speed. */
export const MIN_SPEED = 1
/** The fastest speed: "instant", the program runs to its next stop at once. */
export const MAX_SPEED = 10
export const DEFAULT_SPEED = 5

/** Milliseconds between two auto-play steps, for the speeds 1 … 9. */
const DELAYS = [1500, 1000, 700, 500, 350, 230, 140, 80, 40] as const

/**
 * Auto-play at the speeds 1 … 9 stops after this many steps with the "may be stuck in a
 * loop" message. No program of the course runs this long (the examples need at most
 * about 150 steps), and at speed 9 it takes 40 seconds to get there; the emulator's own
 * limit (10 000 steps, for Run at "instant") would take 7 minutes at speed 9.
 */
export const AUTO_PLAY_MAX_STEPS = 1000

/** A whole number from 1 to 10. Anything else becomes the nearest one (or the default). */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return DEFAULT_SPEED
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed)))
}

/** The wait before the next auto-play step: 1 ≈ 1500 ms, 5 ≈ 350 ms, 9 ≈ 40 ms, 10 = 0. */
export function stepDelay(speed: number): number {
  const clamped = clampSpeed(speed)
  return clamped >= MAX_SPEED ? 0 : DELAYS[clamped - 1]
}

/* ──────────────────────────────── Shapes ──────────────────────────────── */

export interface SessionState {
  source: string
  /** The starting state the program runs with (registers, memory, stdin, …), if any. */
  options: EmulatorOptions | undefined
  /** Errors and warnings from the last assemble. */
  diagnostics: readonly Diagnostic[]
  /** True when the program assembled (no errors). */
  ok: boolean
  /** Machine snapshot; null when the program has errors. */
  machine: MachineState | null
  /** The assembled program; null when the program has errors. */
  program: Program | null
  /** Lines with a breakpoint, ascending. Kept while the program has errors, too. */
  breakpoints: readonly number[]
  /** Auto-play is on. */
  playing: boolean
  /** Auto-play speed, 1 (slowest) … 10 (instant). */
  speed: number
  /** Why the last Run / auto-play stopped (a friendly sentence), or null. */
  runMessage: string | null
  /** The same reason as data ('breakpoint', 'step-limit', …), or null with `runMessage`. */
  runStop: RunStopReason | null
  /**
   * True after an edit restarted a program that was already running. It stays true while
   * the student keeps typing, and goes back to false when the machine moves again
   * (step, back, run, reset) or another program is loaded.
   */
  restartedByEdit: boolean
  /**
   * True after an edit that did not change what the program does (a comment, spaces):
   * the machine stayed at the same step. Goes back to false like `restartedByEdit`.
   */
  keptPlaceAfterEdit: boolean
  /** Reset just took the machine back to the start: `undoReset()` goes back to step N. */
  undoResetTo: number | null
  /**
   * The last step is a library call whose tip about junk registers was already shown at
   * an earlier step of this run, so a short reminder is enough.
   */
  repeatedTip: boolean
  /**
   * Goes up by one each time a control moves the machine (Step, Back, Run, Reset, undo
   * Reset, the input for scanf). A page can show a note "until the student moves on":
   * remember this number with the note, and show the note while it is the same.
   */
  moves: number
}

/** The two timer functions auto-play needs. Tests pass their own. */
export interface SessionTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SessionInit {
  source: string
  options?: EmulatorOptions
  /** 1 … 10. Default 5. */
  speed?: number
  /** Default: the global setTimeout / clearTimeout, looked up at the moment of the call. */
  timers?: SessionTimers
}

const GLOBAL_TIMERS: SessionTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
}

const NO_LINES: readonly number[] = Object.freeze([])

/** Text the student typed for scanf, and the step count when it was typed. */
interface TypedInput {
  at: number
  text: string
}

const NO_INPUT: readonly TypedInput[] = Object.freeze([])

/** A place in a run that can be built again: how many steps, which typed input. */
interface Place {
  steps: number
  inputs: readonly TypedInput[]
  /** The machine was waiting for input there. */
  waiting: boolean
}

/* ─────────────────────── Starting state from outside ──────────────────────── */

/**
 * The options with the two limits that protect the page kept in range. A share link can
 * carry any number, and Run at "instant" runs `maxSteps` steps in one go (a crafted link
 * with an endless loop and a huge limit would freeze the tab). A bigger stack than the
 * usual 1 MiB only makes the Stack panel longer.
 */
export function safeOptions(options: EmulatorOptions | undefined): EmulatorOptions | undefined {
  if (options === undefined) return undefined
  const { maxSteps, stackSize } = options
  const safe: EmulatorOptions = { ...options }
  if (maxSteps !== undefined) {
    safe.maxSteps = Number.isFinite(maxSteps)
      ? Math.min(DEFAULT_OPTIONS.maxSteps, Math.max(1, Math.floor(maxSteps)))
      : DEFAULT_OPTIONS.maxSteps
  }
  if (stackSize !== undefined) {
    safe.stackSize = Number.isFinite(stackSize)
      ? Math.min(DEFAULT_OPTIONS.stackSize, Math.max(0, Math.floor(stackSize)))
      : DEFAULT_OPTIONS.stackSize
  }
  return safe
}

/* ─────────────────────── Why auto-play stopped ──────────────────────── */

interface RunStop {
  reason: RunStopReason
  message: string
}

/**
 * Why auto-play stopped, in the emulator's own words (the sentence its `run()` gives), so
 * Run at "instant" speed and Run at any other speed say the same thing.
 */
function runStop(reason: RunStopReason, line: number | null, steps: number): RunStop {
  return { reason, message: runStopMessage(reason, { line, steps }) }
}

/** Nothing stopped a run: no reason, no sentence. */
const NO_STOP = { runMessage: null, runStop: null } as const

/** The machine moved: the notes about the last edit and the last Reset no longer apply. */
const MOVED = { restartedByEdit: false, keptPlaceAfterEdit: false, undoResetTo: null } as const

function withStop(stop: RunStop): Pick<SessionState, 'runMessage' | 'runStop'> {
  return { runMessage: stop.message, runStop: stop.reason }
}

/** How many lines the editor shows for this text (a final line break starts a new line). */
function lineCount(source: string): number {
  return source.split('\n').length
}

/* ───────────────────────── What a program does ───────────────────────── */

function operandFacts(operand: Operand): unknown[] {
  switch (operand.kind) {
    case 'reg':
      return ['reg', operand.reg.name]
    case 'imm':
      return ['imm', operand.value]
    case 'mem':
      return [
        'mem',
        operand.size,
        operand.base,
        operand.index,
        operand.scale,
        operand.disp,
        operand.symbolAddress,
      ]
    case 'target':
      return ['target', operand.address, operand.external ? operand.name : null]
  }
}

/**
 * Everything that decides what a program DOES, and nothing else: the instructions with
 * their addresses and resolved operands, and the bytes of the data. Line numbers,
 * comments, spaces and the names of labels are left out. Two programs with the same
 * text here run exactly the same steps.
 */
function programBehaviour(program: Program): string {
  return JSON.stringify(
    {
      entry: program.entry,
      code: program.instructions.map((instruction) => [
        instruction.address,
        instruction.size,
        instruction.mnemonic,
        instruction.opSize,
        instruction.operands.map(operandFacts),
      ]),
      data: program.data.map((item) => [item.address, item.section, item.bytes]),
    },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(16) : value),
  )
}

/** True when the step is a library call that came with the tip about junk registers. */
function hasLibraryTip(machine: MachineState | null): boolean {
  const step = machine?.lastStep ?? null
  return step !== null && step.kind === 'library' && step.notes.some((note) => note.kind === 'tip')
}

/* ─────────────────────────────── Session ─────────────────────────────── */

export class StepperSession {
  private readonly timers: SessionTimers
  private readonly listeners = new Set<{ listener: () => void }>()
  private options: EmulatorOptions | undefined
  private emulator: Emulator | null = null
  private breakpoints: readonly number[] = NO_LINES
  private state: SessionState

  /** The pending auto-play step, if one is scheduled. */
  private timer: { handle: unknown } | null = null
  /** Steps run since auto-play started (for the endless-loop guard). */
  private playSteps = 0
  /** Auto-play stopped because scanf needed input: go on once the input is there. */
  private resumeAfterInput = false
  /** The text typed for scanf in this run, in order (to build a place again). */
  private inputs: readonly TypedInput[] = NO_INPUT
  /** Where the machine was before the last Reset (for `undoReset`). */
  private beforeReset: Place | null = null
  /**
   * The last place of a program that assembled, with what that program does. An edit
   * that ends with the same behaviour (also after a typo that was fixed again) goes back
   * to that place.
   */
  private lastPlace: (Place & { behaviour: string }) | null = null
  /** The first step of this run that showed the tip about junk registers. */
  private firstTipStep: number | null = null

  constructor(init: SessionInit) {
    this.timers = init.timers ?? GLOBAL_TIMERS
    this.options = safeOptions(init.options)
    const built = this.build(init.source)
    this.state = Object.freeze({
      source: init.source,
      options: this.options,
      ...built,
      breakpoints: NO_LINES,
      playing: false,
      speed: clampSpeed(init.speed ?? DEFAULT_SPEED),
      ...NO_STOP,
      ...MOVED,
      repeatedTip: false,
      moves: 0,
    })
  }

  /* ───────────────────────── Store (useSyncExternalStore) ───────────────────────── */

  /** The current state. The same object until something changes. */
  readonly getState = (): SessionState => this.state

  /** Call `listener` after every change. Returns the function that unsubscribes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    const entry = { listener }
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  /** The options the program runs with (starting registers, memory, stdin, …). */
  getOptions(): EmulatorOptions | undefined {
    return this.options
  }

  /* ───────────────────────────── The program ───────────────────────────── */

  /**
   * The student edited the program: assemble the new text. When it does the same as
   * before (only comments or spaces changed), the machine stays at the same step;
   * otherwise it starts from the top. Breakpoints stay (lines past the end are dropped).
   */
  setSource(source: string): void {
    if (source === this.state.source) return
    const { machine, playing, restartedByEdit, program } = this.state
    const wasRunning = playing || (machine !== null && machine.stepCount > 0)
    const place =
      machine !== null && program !== null
        ? { ...this.placeOf(machine), behaviour: programBehaviour(program) }
        : this.lastPlace
    this.stopAutoPlay()
    const lines = lineCount(source)
    if (this.breakpoints.some((line) => line > lines)) {
      this.breakpoints = Object.freeze(this.breakpoints.filter((line) => line <= lines))
    }
    const built = this.build(source)
    // A typo on the way keeps the old place, so fixing it again comes back to it.
    this.lastPlace = built.program === null ? place : null
    const kept =
      built.program !== null &&
      this.emulator !== null &&
      place !== null &&
      place.steps > 0 &&
      programBehaviour(built.program) === place.behaviour
    if (kept && this.emulator !== null && place !== null) {
      this.goTo(this.emulator, place)
      built.machine = this.emulator.getSnapshot()
    }
    this.replace({
      source,
      ...built,
      breakpoints: this.breakpoints,
      playing: false,
      ...NO_STOP,
      restartedByEdit: !kept && (restartedByEdit || wasRunning),
      keptPlaceAfterEdit: kept,
      undoResetTo: null,
      repeatedTip: this.tipRepeated(built.machine),
    })
  }

  /**
   * Another program replaces this one (an example, a shared link). Unlike an edit, this
   * clears the breakpoints and says nothing about a restart.
   */
  load(source: string, options?: EmulatorOptions): void {
    this.stopAutoPlay()
    this.options = safeOptions(options)
    this.breakpoints = NO_LINES
    this.lastPlace = null
    const built = this.build(source)
    this.replace({
      source,
      options: this.options,
      ...built,
      breakpoints: NO_LINES,
      playing: false,
      ...NO_STOP,
      ...MOVED,
      repeatedTip: false,
    })
  }

  /** New starting state for the same program. The program starts from the top. */
  setOptions(options: EmulatorOptions | undefined): void {
    if (options === this.options) return
    this.options = safeOptions(options)
    this.stopAutoPlay()
    this.lastPlace = null
    this.replace({
      options: this.options,
      ...this.build(this.state.source),
      playing: false,
      ...NO_STOP,
      ...MOVED,
      repeatedTip: false,
    })
  }

  /* ───────────────────────────── Controls ───────────────────────────── */

  /** Run one step. Stops auto-play first. */
  step(): void {
    const emulator = this.emulator
    if (emulator === null) return
    this.stopAutoPlay()
    if (emulator.getSnapshot().status !== 'running') {
      this.sync({ playing: false })
      return
    }
    emulator.step()
    this.sync({ playing: false, ...NO_STOP, ...this.moved() })
  }

  /**
   * Undo the last step. Stops auto-play first.
   *
   * When that step read text the student typed for scanf, the text is taken back too:
   * stepping forward again asks for new input (the student can type another answer).
   */
  back(): void {
    const emulator = this.emulator
    if (emulator === null) return
    this.stopAutoPlay()
    const { stepCount } = emulator.getSnapshot()
    const target = stepCount - 1
    if (target >= 0 && this.inputs.some((input) => input.at >= target)) {
      this.inputs = Object.freeze(this.inputs.filter((input) => input.at < target))
      this.replay(emulator, { steps: target, inputs: this.inputs, waiting: false })
    } else if (!emulator.stepBack()) {
      this.sync({ playing: false })
      return
    }
    this.sync({ playing: false, ...NO_STOP, ...this.moved() })
  }

  /**
   * Start auto-play at the current speed. The first step runs at once. Speed 10 runs the
   * program to its next stop (the end, a breakpoint, input, an error) in one go.
   */
  play(): void {
    const emulator = this.emulator
    if (emulator === null || this.state.playing) return
    if (emulator.getSnapshot().status !== 'running') return
    this.resumeAfterInput = false
    if (this.state.speed >= MAX_SPEED) {
      this.runToStop()
      return
    }
    this.playSteps = 0
    this.sync({ playing: true, ...NO_STOP, ...this.moved() })
    this.advance()
  }

  pause(): void {
    if (!this.state.playing) return
    this.stopAutoPlay()
    this.sync({ playing: false })
  }

  /**
   * Back to the start of the program. Breakpoints and the speed stay. Until the machine
   * moves again, `undoReset()` goes back to where it was.
   */
  reset(): void {
    const emulator = this.emulator
    if (emulator === null) return
    this.stopAutoPlay()
    const machine = emulator.getSnapshot()
    const place = machine.stepCount > 0 ? this.placeOf(machine) : null
    emulator.reset()
    this.inputs = NO_INPUT
    this.firstTipStep = null
    this.beforeReset = place
    this.sync({ playing: false, ...NO_STOP, ...this.moved(), undoResetTo: place?.steps ?? null })
  }

  /** Go back to where the machine was before the last Reset (same steps, same input). */
  undoReset(): void {
    const emulator = this.emulator
    const place = this.beforeReset
    if (emulator === null || place === null || this.state.undoResetTo === null) return
    this.stopAutoPlay()
    this.goTo(emulator, place)
    this.sync({ playing: false, ...NO_STOP, ...this.moved() })
  }

  setSpeed(speed: number): void {
    const next = clampSpeed(speed)
    if (next === this.state.speed) return
    this.sync({ speed: next })
    if (!this.state.playing) return
    // Auto-play is on: the new speed counts from now.
    this.cancelTimer()
    if (next >= MAX_SPEED) this.runToStop()
    else this.schedule()
  }

  /**
   * Switch the breakpoint of a line. A line without an instruction (a label, a comment, a
   * blank line) cannot be stopped at, so its breakpoint goes on the next line that has
   * one, as gdb does: a click on `loop_start:` stops before the first instruction of the
   * loop.
   */
  toggleBreakpoint(line: number): void {
    if (!Number.isInteger(line) || line < 1) return
    const target = this.instructionLineFrom(line)
    const lines = new Set(this.breakpoints)
    if (!lines.delete(target)) lines.add(target)
    this.useBreakpoints([...lines])
  }

  /**
   * Replace all the breakpoints, for example with the new line numbers the editor gives
   * after an edit moved them (a line added above a breakpoint moves it down). Lines that
   * cannot be a line are left out. Does nothing when the list is the same.
   */
  setBreakpoints(lines: readonly number[]): void {
    const next = [...new Set(lines.filter((line) => Number.isInteger(line) && line >= 1))]
    const sorted = next.sort((a, b) => a - b)
    const same =
      sorted.length === this.breakpoints.length &&
      sorted.every((line, index) => line === this.breakpoints[index])
    if (!same) this.useBreakpoints(sorted)
  }

  private useBreakpoints(lines: number[]): void {
    this.breakpoints = Object.freeze(lines.sort((a, b) => a - b))
    this.emulator?.setBreakpoints(this.breakpoints)
    this.sync({ breakpoints: this.breakpoints })
  }

  /** `line` when it holds an instruction (or nothing is known), else the next one that does. */
  private instructionLineFrom(line: number): number {
    const program = this.state.program
    if (program === null || program.lineToIndex.has(line)) return line
    let next: number | null = null
    for (const instruction of program.instructions) {
      if (instruction.line > line && (next === null || instruction.line < next)) {
        next = instruction.line
      }
    }
    return next ?? line
  }

  /**
   * Text the student typed for scanf. When the program was waiting for it, the waiting
   * step runs at once (scanf reads the text and returns), and auto-play goes on if it
   * was auto-play that stopped for the input, unless a breakpoint is on the line that
   * runs next: Run never runs past a breakpoint that it reaches.
   */
  provideInput(text: string): void {
    const emulator = this.emulator
    if (emulator === null) return
    const before = emulator.getSnapshot()
    const waiting = before.status === 'waiting-input'
    this.inputs = Object.freeze([...this.inputs, { at: before.stepCount, text }])
    emulator.provideInput(text)
    if (!waiting) {
      this.sync({ undoResetTo: null })
      return
    }
    emulator.step()
    const machine = emulator.getSnapshot()
    const after = machine.status
    const resume = this.resumeAfterInput && after === 'running'
    // Still waiting (scanf wants more values): the next input may resume auto-play too.
    this.resumeAfterInput = this.resumeAfterInput && after === 'waiting-input'
    if (!resume) {
      this.sync({
        ...(after === 'waiting-input' ? withStop(runStop('waiting-input', null, 0)) : NO_STOP),
        ...this.moved(),
      })
      return
    }
    const line = machine.inLibrary === null ? machine.nextLine : null
    if (line !== null && this.breakpoints.includes(line)) {
      this.sync({ playing: false, ...withStop(runStop('breakpoint', line, 0)), ...this.moved() })
      return
    }
    this.sync({ ...NO_STOP, ...this.moved() })
    this.play()
  }

  /** Stop the timers. The session can still be used afterwards (React StrictMode). */
  dispose(): void {
    this.stopAutoPlay()
    if (this.state.playing) this.sync({ playing: false })
  }

  /* ───────────────────────────── Inside ───────────────────────────── */

  /** A control moved the machine: the notes of `MOVED` go away, and `moves` goes up. */
  private moved(): typeof MOVED & Pick<SessionState, 'moves'> {
    return { ...MOVED, moves: this.state.moves + 1 }
  }

  /** Assemble `source` with the current options and make its emulator. A fresh run. */
  private build(source: string): Pick<SessionState, 'diagnostics' | 'ok' | 'machine' | 'program'> {
    this.inputs = NO_INPUT
    this.beforeReset = null
    this.firstTipStep = null
    const created = createEmulator(source, this.options)
    const diagnostics = Object.freeze([...created.diagnostics])
    if (!created.ok) {
      this.emulator = null
      return { diagnostics, ok: false, machine: null, program: null }
    }
    const emulator = created.emulator
    emulator.setBreakpoints(this.breakpoints)
    this.emulator = emulator
    return { diagnostics, ok: true, machine: emulator.getSnapshot(), program: emulator.program }
  }

  private placeOf(machine: MachineState): Place {
    return {
      steps: machine.stepCount,
      inputs: this.inputs,
      waiting: machine.status === 'waiting-input',
    }
  }

  /** Build `place` again from the start and make it the place of this run. */
  private goTo(emulator: Emulator, place: Place): void {
    this.inputs = place.inputs
    this.replay(emulator, place)
  }

  /**
   * Run the program again from the start up to `place.steps`, giving scanf each typed
   * text at the step count where it was typed. Breakpoints do not stop it (it uses
   * `step()`, not `run()`).
   */
  private replay(emulator: Emulator, place: Place): void {
    emulator.reset()
    this.firstTipStep = null
    let count = 0
    while (count < place.steps) {
      for (const input of place.inputs) if (input.at === count) emulator.provideInput(input.text)
      const result = emulator.step()
      if (!result.executed) break
      count = result.stepNumber
    }
    // Input typed there for a later scanf, then the wait itself (a step that does not run).
    for (const input of place.inputs) if (input.at === count) emulator.provideInput(input.text)
    if (place.waiting && count === place.steps) emulator.step()
  }

  /** One auto-play step, then either stop (with the reason) or schedule the next one. */
  private readonly advance = (): void => {
    this.timer = null
    const emulator = this.emulator
    if (emulator === null || !this.state.playing) return
    emulator.step()
    this.playSteps += 1
    const machine = emulator.getSnapshot()
    const stop = this.stopReason(machine)
    if (stop !== null) {
      this.resumeAfterInput = machine.status === 'waiting-input'
      this.sync({ playing: false, ...withStop(stop) })
      return
    }
    this.sync()
    // A listener may have paused (or stepped) while it was told about this step.
    if (this.state.playing && this.timer === null) this.schedule()
  }

  /** Why auto-play must stop after this step, or null to go on. */
  private stopReason(machine: MachineState): RunStop | null {
    switch (machine.status) {
      case 'halted':
        return runStop('halted', null, this.playSteps)
      case 'error':
        return runStop('error', machine.error?.line ?? null, this.playSteps)
      case 'waiting-input':
        return runStop('waiting-input', null, this.playSteps)
      case 'running':
        break
    }
    // Breakpoints are on lines of the program, never inside library code.
    const line = machine.inLibrary === null ? machine.nextLine : null
    if (line !== null && this.breakpoints.includes(line)) {
      return runStop('breakpoint', line, this.playSteps)
    }
    if (this.playSteps >= this.autoPlayLimit()) {
      return runStop('step-limit', null, this.playSteps)
    }
    return null
  }

  /** The endless-loop guard of auto-play (speeds 1 … 9). */
  private autoPlayLimit(): number {
    const limit = this.options?.maxSteps
    const emulatorLimit = typeof limit === 'number' && limit >= 1 ? limit : DEFAULT_OPTIONS.maxSteps
    return Math.min(emulatorLimit, AUTO_PLAY_MAX_STEPS)
  }

  /** Speed 10: the emulator runs to the next stop by itself (at most `maxSteps` steps). */
  private runToStop(): void {
    const emulator = this.emulator
    if (emulator === null) return
    const result = emulator.run()
    this.resumeAfterInput = result.reason === 'waiting-input'
    this.sync({
      playing: false,
      runMessage: result.message,
      runStop: result.reason,
      ...this.moved(),
    })
  }

  private schedule(): void {
    this.cancelTimer()
    this.timer = { handle: this.timers.setTimeout(this.advance, stepDelay(this.state.speed)) }
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer.handle)
    this.timer = null
  }

  /** Cancel the next auto-play step and forget a pending "go on after the input". */
  private stopAutoPlay(): void {
    this.cancelTimer()
    this.resumeAfterInput = false
  }

  /** Is the tip of the last step one that this run showed before? Remembers the first one. */
  private tipRepeated(machine: MachineState | null): boolean {
    const step = machine?.lastStep ?? null
    if (step === null || !hasLibraryTip(machine)) return false
    if (this.firstTipStep === null || step.stepNumber < this.firstTipStep) {
      this.firstTipStep = step.stepNumber
    }
    return step.stepNumber > this.firstTipStep
  }

  /** Read the emulator's snapshot, apply `patch`, and tell the listeners if anything changed. */
  private sync(patch: Partial<SessionState> = {}): void {
    const machine = this.emulator?.getSnapshot() ?? null
    const next: SessionState = {
      ...this.state,
      ...patch,
      machine,
      repeatedTip: this.tipRepeated(machine),
    }
    const keys = Object.keys(next) as (keyof SessionState)[]
    if (keys.every((key) => Object.is(next[key], this.state[key]))) return
    this.state = Object.freeze(next)
    this.emit()
  }

  private replace(patch: Partial<SessionState>): void {
    this.state = Object.freeze({ ...this.state, ...patch })
    this.emit()
  }

  private emit(): void {
    for (const entry of [...this.listeners]) entry.listener()
  }
}
