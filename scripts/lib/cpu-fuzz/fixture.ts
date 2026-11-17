/**
 * The fixture file: `src/emulator/__fixtures__/cpu-fuzz.json`.
 *
 * The same shape is read by `src/emulator/cpu-fuzz.test.ts`. The text is built by hand
 * (a readable header, then one program per line) so that the file stays small, diffs
 * stay readable, and two runs with the same seed give exactly the same bytes.
 */
import type { FlagName } from './model'
import { FREE_REGISTERS, type FreeRegister } from './program'
import type { FuzzStats } from './stats'

export interface FixtureProgram {
  id: string
  /** The program exactly as the emulator should assemble it (the test adds `ret`). */
  body: string
  /** Final value of every free register, as "0x" + 16 hex digits. */
  registers: Record<FreeRegister, string>
  flags: Record<FlagName, 0 | 1>
  /** The 256 scratch bytes after the run, as 512 hex digits (byte 0 first). */
  scratch: string
}

export interface FixtureHeader {
  about: string
  generatedBy: string
  seed: number
  count: number
  /** Where the expected values came from: CPU, operating system, compiler. */
  host: string
  /** The registers that are compared, in the order the test reports them. */
  registerOrder: readonly FreeRegister[]
  coverage: FuzzStats
}

export function hex64(value: bigint): string {
  return `0x${value.toString(16).padStart(16, '0')}`
}

export function hexBytes(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return text
}

export function fixtureHeader(
  seed: number,
  count: number,
  host: string,
  coverage: FuzzStats,
): FixtureHeader {
  return {
    about:
      'Random straight-line x86-64 programs and what a real CPU left in the registers, ' +
      'the flags and the scratch memory after running each one. ' +
      'src/emulator/cpu-fuzz.test.ts replays every program in the emulator and compares. ' +
      'Do not edit by hand: run the generator again.',
    generatedBy: `node scripts/make-cpu-fuzz-fixture.mjs --seed ${seed} --count ${count}`,
    seed,
    count,
    host,
    registerOrder: FREE_REGISTERS,
    coverage,
  }
}

/** The exact text of the fixture file. */
export function fixtureText(header: FixtureHeader, programs: readonly FixtureProgram[]): string {
  const head = JSON.stringify(header, null, 2)
  const lines = programs.map((program) => `    ${JSON.stringify(program)}`)
  // `head` ends with "\n}". Put the programs in before the closing brace.
  return `${head.slice(0, -2)},\n  "programs": [\n${lines.join(',\n')}\n  ]\n}\n`
}
