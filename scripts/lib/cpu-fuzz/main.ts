/**
 * The work behind `node scripts/make-cpu-fuzz-fixture.mjs`:
 *
 *   generate programs → check them in the reference model → build and run them as real
 *   x86-64 code → make sure the model and the CPU agree → write the fixture.
 *
 * The expected values in the fixture are the CPU's, never the model's.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  build,
  describeHost,
  findX86Compiler,
  makeWorkDir,
  removeWorkDir,
} from '../native/toolchain'
import { run } from '../proc'
import { fixtureHeader, fixtureText, hex64, hexBytes, type FixtureProgram } from './fixture'
import { generatePrograms } from './generate'
import { FLAG_NAMES, SCRATCH_BYTES, runModel, type ModelResult } from './model'
import { DRIVER_SOURCE, nativeAssembly, parseDriverOutput, type NativeResult } from './native'
import { FREE_REGISTERS, emulatorBody, type FreeRegister, type FuzzProgram } from './program'
import { collectStats, coverageGaps, type FuzzStats } from './stats'

export const DEFAULT_SEED = 2026
export const DEFAULT_COUNT = 600
/** The brief asks for a fixture under about 1.5 MB. */
const MAX_FIXTURE_BYTES = 1_500_000
/** From this size on, every form, register name and jump outcome must be covered. */
const FULL_COVERAGE_FROM = 400

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DEFAULT_OUT = path.join(REPO_ROOT, 'src', 'emulator', '__fixtures__', 'cpu-fuzz.json')

const USAGE = `Usage: node scripts/make-cpu-fuzz-fixture.mjs [options]

Builds random x86-64 programs, runs them on the real CPU and saves what the CPU did in
src/emulator/__fixtures__/cpu-fuzz.json. The emulator test replays that file.

  --seed N      seed of the random programs (default ${DEFAULT_SEED})
  --count N     how many programs (default ${DEFAULT_COUNT})
  --out FILE    where to write the fixture (default src/emulator/__fixtures__/cpu-fuzz.json)
  --no-write    run and check everything, but do not write a file
  --stats-only  only generate the programs and print what they cover (no compiler needed)
  --keep        keep the folder with the generated assembly, and print where it is
  --help        show this text
`

interface Options {
  seed: number
  count: number
  out: string
  write: boolean
  statsOnly: boolean
  keep: boolean
  help: boolean
}

export function parseOptions(argv: readonly string[]): Options | { error: string } {
  const options: Options = {
    seed: DEFAULT_SEED,
    count: DEFAULT_COUNT,
    out: DEFAULT_OUT,
    write: true,
    statsOnly: false,
    keep: false,
    help: false,
  }
  const wholeNumber = (name: string, text: string | undefined, max: number): number | string => {
    if (text === undefined || !/^\d+$/.test(text)) return `${name} needs a whole number`
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value > max) return `${name} must be at most ${max}`
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--no-write') options.write = false
    else if (arg === '--stats-only') options.statsOnly = true
    else if (arg === '--seed') {
      const value = wholeNumber('--seed', argv[++i], 0xffff_ffff)
      if (typeof value === 'string') return { error: value }
      options.seed = value
    } else if (arg === '--count') {
      const value = wholeNumber('--count', argv[++i], 100_000)
      if (typeof value === 'string') return { error: value }
      if (value < 1) return { error: '--count must be at least 1' }
      options.count = value
    } else if (arg === '--out') {
      const value = argv[++i]
      if (value === undefined) return { error: '--out needs a file name' }
      options.out = path.resolve(value)
    } else {
      return { error: `unknown option ${String(arg)}` }
    }
  }
  return options
}

/** Where the model and the CPU disagree about one program (empty when they agree). */
export function compareModelWithCpu(model: ModelResult, cpu: NativeResult): string[] {
  const problems: string[] = []
  for (const name of FREE_REGISTERS) {
    if (model.registers[name] !== cpu.registers[name]) {
      problems.push(
        `${name}: model ${hex64(model.registers[name])}, CPU ${hex64(cpu.registers[name])}`,
      )
    }
  }
  for (const flag of FLAG_NAMES) {
    if (model.flags[flag] !== cpu.flags[flag]) {
      problems.push(`${flag}: model ${model.flags[flag]}, CPU ${cpu.flags[flag]}`)
    }
  }
  for (let i = 0; i < SCRATCH_BYTES; i++) {
    if (model.scratch[i] !== cpu.scratch[i]) {
      problems.push(
        `scratch byte ${i}: model 0x${(model.scratch[i] ?? 0).toString(16)}, ` +
          `CPU 0x${(cpu.scratch[i] ?? 0).toString(16)}`,
      )
    }
  }
  return problems
}

function fixtureProgram(program: FuzzProgram, cpu: NativeResult): FixtureProgram {
  const registers = Object.fromEntries(
    FREE_REGISTERS.map((name) => [name, hex64(cpu.registers[name])]),
  ) as Record<FreeRegister, string>
  return {
    id: program.id,
    body: emulatorBody(program),
    registers,
    flags: cpu.flags,
    scratch: hexBytes(cpu.scratch),
  }
}

function columns(entries: readonly string[], width: number, perRow: number): string[] {
  const rows: string[] = []
  for (let i = 0; i < entries.length; i += perRow) {
    rows.push(
      '  ' +
        entries
          .slice(i, i + perRow)
          .map((entry) => entry.padEnd(width))
          .join('')
          .trimEnd(),
    )
  }
  return rows
}

export function describeStats(stats: FuzzStats): string {
  const out: string[] = []
  out.push(
    `${stats.programs} programs, ${stats.instructions} instructions in all ` +
      `(the random middle part has ${stats.shortest} to ${stats.longest} instructions per program).`,
  )
  out.push('')
  out.push('Instruction forms (how many of each):')
  out.push(
    ...columns(
      Object.entries(stats.forms).map(([form, n]) => `${form} ${n}`),
      24,
      4,
    ),
  )
  out.push('')
  out.push('Mnemonics as written (aliases included):')
  out.push(
    ...columns(
      Object.entries(stats.spellings).map(([name, n]) => `${name} ${n}`),
      14,
      7,
    ),
  )
  out.push('')
  out.push(
    'Operand widths: ' +
      ['8', '16', '32', '64'].map((size) => `${size}-bit ${stats.sizes[size] ?? 0}`).join(', '),
  )
  const uses = Object.entries(stats.registers)
  const unused = uses.filter(([, n]) => n === 0).map(([name]) => name)
  const least = uses.reduce((low, entry) => (entry[1] < low[1] ? entry : low), uses[0] ?? ['', 0])
  out.push(
    `Register names: ${uses.length - unused.length} of ${uses.length} used` +
      (unused.length > 0
        ? ` (unused: ${unused.join(' ')})`
        : ` (least used: ${least[0]}, ${least[1]} times)`),
  )
  out.push(
    `Memory operands: ${stats.memory.operands} ` +
      `(${stats.memory.numberFirst} written as K[r15], ${stats.memory.explicitSize} with a size word)`,
  )
  out.push('')
  out.push('Jumps: reached / taken / not taken')
  out.push(
    ...columns(
      Object.entries(stats.jumps).map(
        ([name, count]) => `${name} ${count.reached}/${count.taken}/${count.notTaken}`,
      ),
      20,
      5,
    ),
  )
  out.push(
    `  after imul (CF/OF only): ${stats.imulProbes.reached}/${stats.imulProbes.taken}/${stats.imulProbes.notTaken}`,
  )
  return out.join('\n')
}

function head(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines
    ? text
    : `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)`
}

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

  console.log(`Generating ${options.count} programs from seed ${options.seed} …`)
  const programs = generatePrograms(options.seed, options.count)
  // The model throws if a program breaks a safety rule: nothing unsafe reaches the CPU.
  const models = programs.map((program) => runModel(program))
  const stats = collectStats(programs, models)
  console.log(describeStats(stats))
  console.log('')

  const gaps = coverageGaps(stats)
  if (gaps.length > 0) {
    console.log(`Not covered by these programs: ${gaps.join('; ')}.`)
    if (options.count >= FULL_COVERAGE_FROM) {
      console.error('A fixture of this size must cover everything. Nothing was written.')
      return 1
    }
  }
  if (options.statsOnly) return 0

  const workDir = await makeWorkDir(options.keep)
  try {
    const search = await findX86Compiler(workDir)
    if (!search.ok) {
      console.log(
        'Cannot run x86-64 code here. That needs clang on a Mac that can run x86-64 programs ' +
          `(Rosetta 2 on Apple Silicon), or gcc on x86-64 Linux. Here: ${search.reason}.`,
      )
      console.log('Nothing was written. An existing fixture is unchanged.')
      return 0
    }
    const compiler = search.compiler

    const assembly = path.join(workDir, 'programs.s')
    const driver = path.join(workDir, 'driver.c')
    const binary = path.join(workDir, 'cpu-fuzz')
    await writeFile(
      assembly,
      nativeAssembly(programs, {
        symbolPrefix: compiler.os === 'macos' ? '_' : '',
        elf: compiler.os === 'linux',
      }),
    )
    await writeFile(driver, DRIVER_SOURCE)
    if (options.keep) console.log(`Build folder: ${workDir}`)

    console.log(`Building with ${compiler.version} …`)
    const built = await build(compiler, [driver, assembly], binary, ['-O1'])
    if (!built.ok) {
      console.error('The generated programs did not build. This is a bug in the generator:')
      console.error(head(built.messages, 40))
      return 1
    }

    console.log('Running on the CPU …')
    const ran = await run(binary, [], { timeoutMs: 300_000, maxOutputBytes: 512 * 1024 * 1024 })
    if (ran.spawnError !== null || ran.timedOut || ran.code !== 0) {
      const why =
        ran.spawnError ??
        (ran.timedOut
          ? 'it did not finish in time'
          : `exit code ${String(ran.code)}, signal ${String(ran.signal)}`)
      console.error(`The native run failed: ${why}.`)
      console.error(head(ran.stderr, 20))
      return 1
    }
    let native: NativeResult[]
    try {
      native = parseDriverOutput(ran.stdout, programs)
    } catch (error) {
      console.error(
        `The native harness reported a problem: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }

    let disagreements = 0
    programs.forEach((program, index) => {
      const model = models[index]
      const cpu = native[index]
      if (model === undefined || cpu === undefined) return
      const problems = compareModelWithCpu(model, cpu)
      if (problems.length === 0) return
      disagreements += 1
      if (disagreements <= 5) {
        console.error(`\nThe model and the CPU disagree on ${program.id}:`)
        for (const problem of problems.slice(0, 8)) console.error(`  ${problem}`)
        console.error(emulatorBody(program))
      }
    })
    if (disagreements > 0) {
      console.error(
        `\n${disagreements} of ${programs.length} programs disagree. Either the harness or the ` +
          'reference model is wrong. Nothing was written.',
      )
      return 1
    }
    console.log(`The reference model and the CPU agree on all ${programs.length} programs.`)

    const host = await describeHost(compiler)
    const text = fixtureText(
      fixtureHeader(options.seed, options.count, host, stats),
      programs.map((program, index) => {
        const cpu = native[index]
        if (cpu === undefined) throw new Error(`No native result for ${program.id}`)
        return fixtureProgram(program, cpu)
      }),
    )
    const bytes = Buffer.byteLength(text)
    const digest = createHash('sha256').update(text).digest('hex')
    console.log(`Host: ${host}`)
    console.log(`Fixture: ${bytes} bytes, sha256 ${digest}`)
    if (!options.write) {
      console.log('--no-write: no file was written.')
      return 0
    }
    if (bytes > MAX_FIXTURE_BYTES) {
      console.error(
        `That is more than ${MAX_FIXTURE_BYTES} bytes. Use a smaller --count. Nothing was written.`,
      )
      return 1
    }
    await mkdir(path.dirname(options.out), { recursive: true })
    await writeFile(options.out, text)
    console.log(`Wrote ${options.out}`)
    return 0
  } finally {
    if (!options.keep) await removeWorkDir(workDir)
  }
}
