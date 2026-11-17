/**
 * The work behind `npm run verify:native`: compare the emulator with real x86-64 code
 * for every example program.
 *
 * Modes, tried in this order (the first one that works is used):
 *   gdb     x86-64 Linux with gcc and gdb: single-step in gdb
 *   lldb    a Mac with clang and lldb: single-step in lldb
 *   trace   a Mac with clang: single-step with the built-in tracer (no debugger needed)
 *   output  only compare what the programs print, and their exit codes
 * When the machine cannot build and run x86-64 code at all, the script says what is
 * missing and ends with exit code 0.
 *
 * Every mode first runs the real program normally and compares its output and exit
 * code. The stepping modes then also compare the registers, rip and the flags after
 * every instruction (the rules are in `compare.ts`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { REG64_NAMES } from '../../../src/emulator/types'
import type { ExampleProgram } from '../../../src/examples/index'
import { findProgram, run } from '../proc'
import { compareRuns, hex64 } from './compare'
import {
  gdbCommands,
  lldbCommands,
  parseGdbTrace,
  parseLldbTrace,
  parseNm,
  type DebuggerFiles,
} from './debuggers'
import {
  loadEmulator,
  runInEmulator,
  type CreateEmulator,
  type EmulatorPoint,
  type EmulatorRun,
} from './emulator'
import { rewriteForMacOS, withTextMarkers } from './macos-source'
import {
  MODE_NAMES,
  count,
  differenceLines,
  programFailed,
  programLine,
  summaryLines,
  visible,
  type Mode,
  type ProgramReport,
} from './report'
import type { NativeState, NativeStep } from './state'
import {
  WHAT_IS_NEEDED,
  build,
  findX86Compiler,
  macDebugPermission,
  makeWorkDir,
  removeWorkDir,
  type X86Compiler,
} from './toolchain'
import {
  TRACER_ENTRY,
  TRACER_SOURCE,
  TRACER_TEXT_END,
  TRACER_TEXT_START,
  parseTracerOutput,
  tracerStates,
} from './tracer'

const USAGE = `Usage: npm run verify:native [-- options]

Builds every example program as real x86-64 code, runs it, and compares it with the
emulator: step by step when the machine allows it, else by output only.

  --mode M        auto (default), gdb, lldb, trace or output
  --only ID,ID    only these examples (ids as in src/examples/index.ts)
  --fuzz ID,ID    instead of the examples, step through these programs of the CPU fuzz
                  fixture (ids such as p0042). Use it when src/emulator/cpu-fuzz.test.ts
                  fails: it shows the first instruction where the emulator goes wrong.
  --timeout N     seconds allowed for one program in a debugger or the tracer (default 20)
  --show-steps    print every step of the real machine (to look into a difference)
  --keep          keep the folder with the built programs, and print where it is
  --help          show this text

Exit code: 0 when everything matched or nothing could be checked, 1 when something differs.
`

const MODES: readonly Mode[] = ['gdb', 'lldb', 'trace', 'output']

interface Options {
  mode: Mode | 'auto'
  only: string[] | null
  fuzz: string[] | null
  timeoutMs: number
  showSteps: boolean
  keep: boolean
  help: boolean
}

export function parseOptions(argv: readonly string[]): Options | { error: string } {
  const options: Options = {
    mode: 'auto',
    only: null,
    fuzz: null,
    timeoutMs: 20_000,
    showSteps: false,
    keep: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--show-steps') options.showSteps = true
    else if (arg === '--mode') {
      const value = argv[++i]
      const mode = MODES.find((item) => item === value)
      if (value === 'auto') options.mode = 'auto'
      else if (mode !== undefined) options.mode = mode
      else return { error: `--mode must be one of: auto, ${MODES.join(', ')}` }
    } else if (arg === '--only') {
      const value = argv[++i]
      if (value === undefined || value === '')
        return { error: '--only needs one or more example ids' }
      options.only = value.split(',').map((id) => id.trim())
    } else if (arg === '--fuzz') {
      const value = argv[++i]
      if (value === undefined || value === '')
        return { error: '--fuzz needs one or more program ids, such as p0042' }
      options.fuzz = value.split(',').map((id) => id.trim())
    } else if (arg === '--timeout') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value <= 0)
        return { error: '--timeout needs a number of seconds' }
      options.timeoutMs = Math.round(value * 1000)
    } else {
      return { error: `unknown option ${String(arg)}` }
    }
  }
  return options
}

interface Context {
  workDir: string
  compiler: X86Compiler
  createEmulator: CreateEmulator | null
  /** Modes still possible, best first. `modes[modeIndex]` is the one in use. */
  modes: Mode[]
  modeIndex: number
  /** True once the mode in use has produced a trace for some program. */
  modeWorked: boolean
  gdb: string | null
  lldb: string | null
  nm: string | null
  timeoutMs: number
  showSteps: boolean
  /** Path of the tracer's C file, once it has been written. */
  tracerDriver: string | null
}

type StepOutcome =
  | {
      ok: true
      states: NativeState[]
      /** Run-time address of a label of the program, when it can be found. */
      nativeSymbol: (label: string) => bigint | null
      note: string | null
      /** True when the debugger ran out of time: the trace is only the first part. */
      cutShort: boolean
    }
  | { ok: false; reason: string }

interface PlainBuild {
  binary: string
  /** Original label → name in the built program. */
  rename: (label: string) => string
  /** Name of `main` in the built program's symbol table. */
  entrySymbol: string
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function loadExamples(): Promise<
  { ok: true; examples: readonly ExampleProgram[] } | { ok: false; reason: string }
> {
  try {
    const loaded: unknown = await import(
      new URL('../../../src/examples/index.ts', import.meta.url).href
    )
    if (isRecord(loaded) && Array.isArray(loaded.EXAMPLES)) {
      return { ok: true, examples: loaded.EXAMPLES as ExampleProgram[] }
    }
    return { ok: false, reason: 'src/examples/index.ts does not export EXAMPLES' }
  } catch (error) {
    return {
      ok: false,
      reason: `src/examples/index.ts could not be loaded (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

const FUZZ_FIXTURE = new URL('../../../src/emulator/__fixtures__/cpu-fuzz.json', import.meta.url)

/**
 * A program of the CPU fuzz fixture as a complete program with a `main` that a real
 * system can call: the fixture's body, between lines that save and restore the
 * registers a function must keep (the body changes all of them).
 */
export function fuzzProgramSource(body: string): string {
  const saved = ['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']
  return [
    '    .intel_syntax noprefix',
    '    .data',
    'scratch: .zero 256',
    '    .text',
    '    .globl main',
    'main:',
    ...saved.map((reg) => `    push ${reg}`),
    body,
    ...saved.toReversed().map((reg) => `    pop ${reg}`),
    '    mov eax, 0',
    '    ret',
    '',
  ].join('\n')
}

async function loadFuzzPrograms(
  ids: readonly string[],
): Promise<{ ok: true; examples: readonly ExampleProgram[] } | { ok: false; reason: string }> {
  let fixture: unknown
  try {
    fixture = JSON.parse(await readFile(FUZZ_FIXTURE, 'utf8'))
  } catch {
    return {
      ok: false,
      reason:
        'src/emulator/__fixtures__/cpu-fuzz.json cannot be read ' +
        '(make it with: node scripts/make-cpu-fuzz-fixture.mjs)',
    }
  }
  const programs = isRecord(fixture) && Array.isArray(fixture.programs) ? fixture.programs : []
  const examples: ExampleProgram[] = []
  for (const id of ids) {
    const found: unknown = programs.find((item: unknown) => isRecord(item) && item.id === id)
    if (!isRecord(found) || typeof found.body !== 'string') {
      return { ok: false, reason: `the fuzz fixture has no program ${id}` }
    }
    examples.push({
      id,
      title: `fuzz program ${id}`,
      description: 'A program of the CPU fuzz fixture.',
      source: fuzzProgramSource(found.body),
      // Fuzz programs print nothing.
      expectedOutput: '',
    })
  }
  return { ok: true, examples }
}

/* ───────────────────────────── building and running ───────────────────────────── */

async function buildPlain(
  ctx: Context,
  example: ExampleProgram,
  dir: string,
): Promise<{ ok: true; build: PlainBuild } | { ok: false; reason: string }> {
  const source = path.join(dir, `${example.id}.s`)
  const binary = path.join(dir, example.id)
  let rename = (label: string): string => label
  let entrySymbol = 'main'
  if (ctx.compiler.os === 'macos') {
    const mac = rewriteForMacOS(example.source, '_main')
    await writeFile(source, `${mac.source}\n`)
    rename = (label) => mac.labels.get(label) ?? label
    entrySymbol = '_main'
  } else {
    // The note tells the linker that the stack need not be executable (gcc adds it too).
    await writeFile(source, `${example.source}\n    .section .note.GNU-stack,"",@progbits\n`)
  }
  let built = await build(ctx.compiler, [source], binary)
  if (!built.ok && ctx.compiler.os === 'linux') {
    // A program that uses a label as a plain address (`mov eax, counter`) cannot be
    // linked as a position-independent program, which is gcc's default. Try without.
    built = await build(ctx.compiler, [source], binary, ['-no-pie'])
  }
  if (!built.ok) return { ok: false, reason: firstLine(built.messages) }
  return { ok: true, build: { binary, rename, entrySymbol } }
}

/** Where the labels of a built program are at run time: `nm` plus where `main` really is. */
async function symbolFinder(
  ctx: Context,
  binary: string,
  entrySymbol: string,
  rename: (label: string) => string,
  runtimeMain: bigint,
): Promise<(label: string) => bigint | null> {
  if (ctx.nm === null) return () => null
  const listed = await run(ctx.nm, [binary], { timeoutMs: 20_000 })
  if (listed.code !== 0) return () => null
  const symbols = parseNm(listed.stdout)
  const staticMain = symbols.get(entrySymbol)
  if (staticMain === undefined) return () => null
  const slide = runtimeMain - staticMain
  return (label) => {
    const address = symbols.get(label === 'main' ? entrySymbol : rename(label))
    return address === undefined ? null : address + slide
  }
}

function planOf(emulated: EmulatorRun): NativeStep[] {
  return emulated.points.slice(1).map((point) => (point.nativeStep === 'over' ? 'over' : 'into'))
}

async function stepWithDebugger(
  kind: 'gdb' | 'lldb',
  ctx: Context,
  example: ExampleProgram,
  dir: string,
  plain: PlainBuild,
  emulated: EmulatorRun,
): Promise<StepOutcome> {
  const program = kind === 'gdb' ? ctx.gdb : ctx.lldb
  if (program === null) return { ok: false, reason: `${kind} is not installed` }
  const plan = planOf(emulated)
  const files: DebuggerFiles = {
    stdin: path.join(dir, 'stdin.txt'),
    stdout: path.join(dir, `${kind}-stdout.txt`),
  }
  const commands = path.join(dir, `commands.${kind}`)
  await writeFile(files.stdin, example.stdin ?? '')
  await writeFile(commands, kind === 'gdb' ? gdbCommands(plan, files) : lldbCommands(plan, files))
  const args =
    kind === 'gdb'
      ? ['--batch', '-nx', '-x', commands, plain.binary]
      : ['--batch', '--no-lldbinit', '--no-use-colors', '--source', commands, plain.binary]
  const result = await run(program, args, {
    timeoutMs: ctx.timeoutMs,
    // No debug-symbol downloads, and a plain shell for gdb's `run < file > file`.
    env: { ...process.env, DEBUGINFOD_URLS: '', SHELL: '/bin/sh' },
    maxOutputBytes: 64 * 1024 * 1024,
  })
  if (result.spawnError !== null) {
    return { ok: false, reason: `${kind} could not start (${result.spawnError})` }
  }
  // The states are on standard output; error messages (for the report) on standard error.
  const printed = `${result.stdout}\n${result.stderr}`
  const trace =
    kind === 'gdb' ? parseGdbTrace(printed, plan.length) : parseLldbTrace(printed, plan.length)
  const start = trace.states[0]
  if (start === undefined) {
    if (result.timedOut) {
      const password =
        kind === 'lldb'
          ? ' (macOS may be waiting for a password before lldb may control another program)'
          : ''
      return {
        ok: false,
        reason: `${kind} did not answer within ${ctx.timeoutMs / 1000} seconds${password}`,
      }
    }
    return { ok: false, reason: trace.problem ?? `${kind} gave no steps` }
  }
  return {
    ok: true,
    states: trace.states,
    nativeSymbol: await symbolFinder(ctx, plain.binary, plain.entrySymbol, plain.rename, start.rip),
    note: result.timedOut ? `${kind} ran out of time after ${trace.states.length - 1} steps` : null,
    cutShort: result.timedOut,
  }
}

async function stepWithTracer(
  ctx: Context,
  example: ExampleProgram,
  dir: string,
  plainOutput: string,
): Promise<StepOutcome> {
  if (ctx.compiler.os !== 'macos') {
    return { ok: false, reason: 'the built-in tracer is only made for macOS' }
  }
  if (ctx.tracerDriver === null) {
    ctx.tracerDriver = path.join(ctx.workDir, 'tracer.c')
    await writeFile(ctx.tracerDriver, TRACER_SOURCE)
  }
  const entrySymbol = `_${TRACER_ENTRY}`
  const mac = rewriteForMacOS(example.source, entrySymbol)
  const source = path.join(dir, 'traced.s')
  const binary = path.join(dir, 'traced')
  const tracePath = path.join(dir, 'trace.txt')
  await writeFile(
    source,
    withTextMarkers(mac.source, `_${TRACER_TEXT_START}`, `_${TRACER_TEXT_END}`),
  )
  const built = await build(ctx.compiler, [ctx.tracerDriver, source], binary, ['-O1'])
  if (!built.ok)
    return { ok: false, reason: `the tracer did not build (${firstLine(built.messages)})` }

  const ran = await run(binary, [tracePath], {
    input: example.stdin ?? '',
    timeoutMs: ctx.timeoutMs,
  })
  let text = ''
  try {
    text = await readFile(tracePath, 'utf8')
  } catch {
    // No file: handled below.
  }
  const output = parseTracerOutput(text)
  if (output === null) {
    return {
      ok: false,
      reason: ran.timedOut
        ? `the traced program did not finish within ${ctx.timeoutMs / 1000} seconds`
        : 'the tracer wrote no trace (single-stepping with the trap flag does not work here)',
    }
  }
  if (output.overflowed) {
    return { ok: false, reason: 'the program runs more steps than the tracer keeps' }
  }
  const states = tracerStates(output)
  if (states.length === 0) return { ok: false, reason: 'the tracer saw no step inside the program' }
  return {
    ok: true,
    states,
    nativeSymbol: await symbolFinder(
      ctx,
      binary,
      entrySymbol,
      (label) => mac.labels.get(label) ?? label,
      output.main,
    ),
    note:
      ran.stdout === plainOutput
        ? null
        : 'the traced run printed something else than the normal run',
    cutShort: false,
  }
}

/**
 * One line per step of the real machine: the instruction the emulator ran for that step
 * (when there is an emulator), where rip is, the flags, and the registers that changed.
 * `differenceAt` is the first step where the two disagree: after it the emulator is on
 * another path, so its instructions are no longer shown.
 */
function describeSteps(
  states: readonly NativeState[],
  points: readonly EmulatorPoint[] = [],
  differenceAt: number | null = null,
): string[] {
  const first = states[0]
  if (first === undefined) return []
  const lines: string[] = []
  states.forEach((state, step) => {
    const before = states[step - 1]
    const changed: string[] = []
    for (const reg of REG64_NAMES) {
      if (before !== undefined && before.registers[reg] !== state.registers[reg]) {
        changed.push(`${reg}=${hex64(state.registers[reg])}`)
      }
    }
    const flags = `CF=${state.flags.CF} ZF=${state.flags.ZF} SF=${state.flags.SF} OF=${state.flags.OF}`
    const offset = BigInt.asIntN(64, state.rip - first.rip)
    const where = offset < 0n ? `main-0x${(-offset).toString(16)}` : `main+0x${offset.toString(16)}`
    let ran = ''
    if (points.length > 0) {
      const point = points[step]
      if (differenceAt !== null && step > differenceAt) ran = '(the emulator is elsewhere)'
      else if (point === undefined) ran = '(the emulator has ended)'
      else ran = point.text === '' ? '(start of main)' : point.text
      ran = `${ran.padEnd(38)} `
    }
    const mark = step === differenceAt ? '   <-- first difference' : ''
    lines.push(
      `      ${String(step).padStart(4)}  ${ran}${where.padEnd(14)} ${flags}  ${changed.join(' ')}`.trimEnd() +
        mark,
    )
  })
  return lines
}

/* ─────────────────────────────── one program ─────────────────────────────── */

async function verifyExample(ctx: Context, example: ExampleProgram): Promise<ProgramReport> {
  const report: ProgramReport = {
    id: example.id,
    mode: 'output',
    stepsCompared: 0,
    differences: [],
    problems: [],
    notes: [],
    emulatorCompared: ctx.createEmulator !== null,
    nativeExitCode: null,
  }
  const stdin = example.stdin ?? ''
  const dir = path.join(ctx.workDir, example.id)
  await mkdir(dir, { recursive: true })

  // 1. The real program: build it, run it, check what it prints.
  const plain = await buildPlain(ctx, example, dir)
  if (!plain.ok) {
    report.problems.push(`the real assembler did not accept the program (${plain.reason})`)
    return report
  }
  const ran = await run(plain.build.binary, [], { input: stdin, timeoutMs: ctx.timeoutMs })
  if (ran.spawnError !== null || ran.timedOut || ran.code === null) {
    const why =
      ran.spawnError ??
      (ran.timedOut ? 'it did not finish in time' : `it was stopped by ${String(ran.signal)}`)
    report.problems.push(`the real program did not run to the end (${why})`)
    return report
  }
  report.nativeExitCode = ran.code
  if (ran.stdout !== example.expectedOutput) {
    report.problems.push(
      `the real program printed ${visible(ran.stdout)}, ` +
        `but the example's expectedOutput is ${visible(example.expectedOutput)}`,
    )
  }

  // 2. The emulator: output and exit code.
  if (ctx.createEmulator === null) {
    if (ctx.showSteps) {
      const traced = await stepWithTracer(ctx, example, dir, ran.stdout)
      if (traced.ok) for (const line of describeSteps(traced.states)) console.log(line)
      else console.log(`      (no steps to show: ${traced.reason})`)
    }
    return report
  }
  const emulated = runInEmulator(ctx.createEmulator, example.source, stdin)
  if (!emulated.ok) {
    report.problems.push(emulated.reason)
    return report
  }
  const emulatorRun = emulated.run
  if (emulatorRun.problem !== null) report.problems.push(emulatorRun.problem)
  if (emulatorRun.output !== ran.stdout) {
    report.problems.push(
      `output: the emulator printed ${visible(emulatorRun.output)}, ` +
        `the real program printed ${visible(ran.stdout)}`,
    )
  }
  if (emulatorRun.exitCode !== null && emulatorRun.exitCode !== ran.code) {
    report.problems.push(
      `exit code: main returned ${emulatorRun.exitCode} in the emulator, ` +
        `the real program ended with ${ran.code}`,
    )
  }

  // 3. Step by step, with the best mode that works on this machine.
  for (;;) {
    const mode = ctx.modes[ctx.modeIndex] ?? 'output'
    if (mode === 'output') break
    const outcome =
      mode === 'trace'
        ? await stepWithTracer(ctx, example, dir, ran.stdout)
        : await stepWithDebugger(mode, ctx, example, dir, plain.build, emulatorRun)
    if (outcome.ok) {
      ctx.modeWorked = true
      report.mode = mode
      if (outcome.note !== null) report.notes.push(outcome.note)
      const result = compareRuns({
        points: emulatorRun.points,
        native: outcome.states,
        layout: emulatorRun.layout,
        nativeSymbol: outcome.nativeSymbol,
        ignoreSfAfterImul: ctx.compiler.rosetta,
      })
      report.stepsCompared = result.stepsCompared
      report.differences = result.differences
      if (ctx.showSteps) {
        const differenceAt = result.differences[0]?.step ?? null
        for (const line of describeSteps(outcome.states, emulatorRun.points, differenceAt)) {
          console.log(line)
        }
      }
      // A trace that the debugger cut short is not a difference: only its part was compared.
      if (result.lengthProblem !== null && !outcome.cutShort) {
        report.problems.push(result.lengthProblem)
      }
      break
    }
    if (ctx.modeWorked) {
      // The mode works on this machine, just not for this program.
      report.notes.push(`not stepped: ${outcome.reason}`)
      break
    }
    // The mode has never worked here: give it up for every program.
    const next = ctx.modes[ctx.modeIndex + 1] ?? 'output'
    console.log(`  Mode "${MODE_NAMES[mode]}" is not possible here: ${outcome.reason}.`)
    console.log(`  Falling back to "${MODE_NAMES[next]}".`)
    ctx.modeIndex += 1
  }
  return report
}

/* ─────────────────────────────── choosing a mode ─────────────────────────────── */

async function chooseModes(
  wanted: Mode | 'auto',
  compiler: X86Compiler,
  emulatorReason: string | null,
): Promise<{ modes: Mode[]; gdb: string | null; lldb: string | null; messages: string[] }> {
  const messages: string[] = []
  const gdb = compiler.os === 'linux' ? findProgram('gdb') : null
  const lldb = compiler.os === 'macos' ? findProgram('lldb') : null

  if (emulatorReason !== null) {
    messages.push(
      `The emulator cannot be loaded yet (${emulatorReason}), so there is nothing to compare ` +
        `step by step. Checking the real programs against each example's expectedOutput.`,
    )
    return { modes: ['output'], gdb, lldb, messages }
  }

  // Everything this machine could do, best first.
  const possible: Mode[] = []
  if (compiler.os === 'linux') {
    if (gdb !== null) possible.push('gdb')
    else messages.push('gdb is not installed, so the programs cannot be single-stepped.')
  } else {
    if (lldb !== null) possible.push('lldb')
    possible.push('trace')
  }
  possible.push('output')

  if (wanted !== 'auto') {
    const position = possible.indexOf(wanted)
    if (position >= 0) return { modes: possible.slice(position), gdb, lldb, messages }
    messages.push(`Mode "${MODE_NAMES[wanted]}" is not possible on this machine.`)
  }

  // Automatic choice: do not start lldb when macOS may answer with a password dialog.
  // The built-in tracer makes the same comparison and needs no permission.
  if (possible[0] === 'lldb' && (await macDebugPermission()) === 'no') {
    messages.push(
      'lldb is installed, but macOS developer mode is off: lldb may stop and wait for a ' +
        'password, and nobody may be there to type it. Using the built-in tracer instead ' +
        '(it makes the same comparison). To use lldb: run this script with `--mode lldb`, ' +
        'or turn developer mode on once with `sudo DevToolsSecurity -enable`.',
    )
    possible.shift()
  }
  return { modes: possible, gdb, lldb, messages }
}

/* ─────────────────────────────────── main ─────────────────────────────────── */

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv)
  if ('error' in options) {
    console.error(`${options.error}\n\n${USAGE}`)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const loaded = options.fuzz === null ? await loadExamples() : await loadFuzzPrograms(options.fuzz)
  if (!loaded.ok) {
    console.log(
      `verify:native ${options.fuzz === null ? 'skipped' : 'cannot start'}: ${loaded.reason}.`,
    )
    return options.fuzz === null ? 0 : 1
  }
  let examples = loaded.examples
  if (options.only !== null) {
    const wanted = options.only
    const unknown = wanted.filter((id) => !examples.some((example) => example.id === id))
    if (unknown.length > 0) {
      console.error(`No example with id: ${unknown.join(', ')}`)
      return 1
    }
    examples = examples.filter((example) => wanted.includes(example.id))
  }

  const workDir = await makeWorkDir(options.keep)
  try {
    const search = await findX86Compiler(workDir)
    if (!search.ok) {
      console.log(`verify:native skipped: it needs ${WHAT_IS_NEEDED}. Here: ${search.reason}.`)
      return 0
    }
    const compiler = search.compiler
    const emulator = await loadEmulator()
    const choice = await chooseModes(options.mode, compiler, emulator.ok ? null : emulator.reason)

    const ctx: Context = {
      workDir,
      compiler,
      createEmulator: emulator.ok ? emulator.createEmulator : null,
      modes: choice.modes,
      modeIndex: 0,
      modeWorked: false,
      gdb: choice.gdb,
      lldb: choice.lldb,
      nm: findProgram('nm'),
      timeoutMs: options.timeoutMs,
      showSteps: options.showSteps,
      tracerDriver: null,
    }

    const detail = `${compiler.version}${compiler.rosetta ? ', x86-64 through Rosetta 2' : ''}`
    console.log(
      `verify:native: ${count(examples.length, options.fuzz === null ? 'example program' : 'fuzz program')} as real x86-64 code (${detail}).`,
    )
    for (const message of choice.messages) console.log(message)
    console.log(`Mode: ${MODE_NAMES[ctx.modes[0] ?? 'output']}.`)
    if (options.keep) console.log(`Build folder: ${workDir}`)
    console.log('')

    const reports: ProgramReport[] = []
    for (const example of examples) {
      const report = await verifyExample(ctx, example)
      reports.push(report)
      console.log(programLine(report))
    }

    for (const line of differenceLines(reports)) console.log(line)
    const failed = reports.filter(programFailed).length
    const lines = summaryLines({
      mode: ctx.modes[ctx.modeIndex] ?? 'output',
      modeDetail: detail,
      programs: reports.length,
      stepsCompared: reports.reduce((sum, report) => sum + report.stepsCompared, 0),
      failed,
      emulatorCompared: ctx.createEmulator !== null,
    })
    for (const line of lines) console.log(line)
    return failed === 0 ? 0 : 1
  } finally {
    if (!options.keep) await removeWorkDir(workDir)
  }
}
