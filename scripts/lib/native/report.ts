/**
 * Turning the results of `verify:native` into text: one line per program, a table of
 * the differences, and the summary.
 */
import type { Difference } from './compare'

export type Mode = 'gdb' | 'lldb' | 'trace' | 'output'

export const MODE_NAMES: Readonly<Record<Mode, string>> = {
  gdb: 'gcc + gdb, single-stepping',
  lldb: 'clang + lldb, single-stepping',
  trace: 'clang + built-in single-step tracer',
  output: 'run and compare output only',
}

export interface ProgramReport {
  id: string
  /** The mode that was really used for this program. */
  mode: Mode
  stepsCompared: number
  /** Register, rip or flag differences at the first step that differs. */
  differences: Difference[]
  /** Output, exit code and "could not run" problems: each one is a failure. */
  problems: string[]
  /** Things worth knowing that are not failures. */
  notes: string[]
  /** False when there was no emulator to compare with (only `expectedOutput` was checked). */
  emulatorCompared: boolean
  /** Exit code of the real program, when it ran to the end. */
  nativeExitCode: number | null
}

export function programFailed(report: ProgramReport): boolean {
  return report.differences.length > 0 || report.problems.length > 0
}

/** Show control characters so that a missing newline is visible: "Hello\n". */
export function visible(text: string): string {
  return JSON.stringify(text)
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    })
  }
  const format = (row: readonly string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  const [header, ...body] = rows
  if (header === undefined) return []
  return [format(header), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(format)]
}

/** The line printed when one program is done. */
export function programLine(report: ProgramReport): string {
  const name = report.id.padEnd(14)
  if (programFailed(report)) {
    const first = report.differences[0]
    const what =
      first !== undefined
        ? `step ${first.step} differs (line ${first.line}: ${first.text || 'start of main'})`
        : (report.problems[0] ?? 'failed')
    return `  ${name}DIFFERENT  ${what}`
  }
  const notes = report.notes.length > 0 ? `  (${report.notes.join('; ')})` : ''
  if (!report.emulatorCompared) {
    const code = report.nativeExitCode === null ? '' : ` (exit code ${report.nativeExitCode})`
    return `  ${name}ok         prints the expected output${code}${notes}`
  }
  const steps = report.mode === 'output' ? '' : `${count(report.stepsCompared, 'step')} compared, `
  return `  ${name}ok         ${steps}output and exit code match${notes}`
}

/** The table of differences and problems, or an empty list when everything matched. */
export function differenceLines(reports: readonly ProgramReport[]): string[] {
  const failed = reports.filter(programFailed)
  if (failed.length === 0) return []
  const lines: string[] = ['', 'Differences:', '']
  const rows: string[][] = [
    ['program', 'step', 'line', 'instruction', 'what', 'emulator', 'real CPU'],
  ]
  for (const report of failed) {
    for (const item of report.differences) {
      rows.push([
        report.id,
        String(item.step),
        String(item.line),
        item.text === '' ? '(start of main)' : item.text,
        item.what,
        item.emulator,
        item.native,
      ])
    }
  }
  if (rows.length > 1) {
    lines.push(...table(rows).map((row) => `  ${row}`))
    lines.push(
      '',
      '  Only the first step that differs is listed for each program: the steps after it',
      '  follow from it. "step" counts the steps of the real machine from the start of main',
      '  (a call to a library function is one step).',
      '',
    )
  }
  for (const report of failed) {
    for (const problem of report.problems) lines.push(`  ${report.id}: ${problem}`)
  }
  return lines
}

export interface Summary {
  mode: Mode
  /** More words about the mode: the compiler, Rosetta, … */
  modeDetail: string
  programs: number
  stepsCompared: number
  failed: number
  /** False when the emulator could not be loaded: only `expectedOutput` was checked. */
  emulatorCompared: boolean
}

export function summaryLines(summary: Summary): string[] {
  const against = summary.emulatorCompared
    ? 'the emulator'
    : "each example's expectedOutput (the emulator is not built yet)"
  const result =
    summary.failed === 0
      ? `everything matched ${against}`
      : `${summary.failed} of ${summary.programs} programs differ from ${against}`
  return [
    '',
    `Summary: mode "${MODE_NAMES[summary.mode]}" (${summary.modeDetail}); ` +
      `${count(summary.programs, 'program')}; ` +
      `${count(summary.stepsCompared, 'step')} compared; ${result}.`,
  ]
}

/** "1 program", "10 programs". */
export function count(amount: number, word: string): string {
  return `${amount} ${word}${amount === 1 ? '' : 's'}`
}
