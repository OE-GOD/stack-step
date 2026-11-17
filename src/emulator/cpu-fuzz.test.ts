/**
 * The emulator against a real x86-64 CPU.
 *
 * `__fixtures__/cpu-fuzz.json` holds hundreds of random straight-line programs and what
 * a real CPU left in the registers, the flags and a 256-byte scratch area after running
 * each one (made by `node scripts/make-cpu-fuzz-fixture.mjs`; this test never needs a
 * compiler). Every program is replayed here in the emulator and must end in exactly the
 * same state.
 *
 * rsp and r15 are not compared: rsp is a stack address and r15 holds the address of the
 * scratch area, and both differ between a real process and the emulator.
 *
 * When a program fails, the message shows the first value that differs and the whole
 * program, ready to paste into `createEmulator()`.
 */
import { describe, expect, it } from 'vitest'
import { createEmulator } from './index'
import { FLAG_NAMES, REG64_NAMES, type Bit, type FlagName, type Reg64 } from './types'

interface FuzzProgram {
  id: string
  /** The program text. The test adds the directives in front and `ret` at the end. */
  body: string
  /** Final value of each compared register: "0x" + 16 hex digits. */
  registers: Record<string, string>
  flags: Record<FlagName, Bit>
  /** The 256 scratch bytes at the end: 512 hex digits, byte 0 first. */
  scratch: string
}

interface FuzzFixture {
  seed: number
  /** The machine the expected values came from. */
  host: string
  /** The registers to compare (all sixteen except rsp and r15). */
  registerOrder: Reg64[]
  programs: FuzzProgram[]
}

const SCRATCH_BYTES = 256
const FIXTURE_PATH = './__fixtures__/cpu-fuzz.json'
const HOW_TO_MAKE_IT = 'node scripts/make-cpu-fuzz-fixture.mjs'

// Loaded as plain text (not as a typed JSON module): the file is over a megabyte, and
// the type checker has no use for it. A missing file gives an empty object here.
const fixtureFiles = import.meta.glob<string>('./__fixtures__/cpu-fuzz.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBit(value: unknown): value is Bit {
  return value === 0 || value === 1
}

/** Read the fixture text and make sure it has the shape this test relies on. */
function parseFixture(text: string): FuzzFixture {
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || !Array.isArray(data.programs) || !Array.isArray(data.registerOrder)) {
    throw new Error(`${FIXTURE_PATH} is damaged. Make it again: ${HOW_TO_MAKE_IT}`)
  }
  const known: readonly string[] = REG64_NAMES
  const registerOrder = data.registerOrder.filter(
    (name): name is Reg64 => typeof name === 'string' && known.includes(name),
  )
  if (registerOrder.length !== data.registerOrder.length) {
    throw new Error(`${FIXTURE_PATH} names a register that does not exist.`)
  }
  const programs = data.programs.map((entry: unknown, position): FuzzProgram => {
    const where = `${FIXTURE_PATH}, program ${position}`
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.body !== 'string') {
      throw new Error(`${where}: id or body is missing.`)
    }
    const { registers, flags, scratch } = entry
    if (!isRecord(registers) || !isRecord(flags) || typeof scratch !== 'string') {
      throw new Error(`${where} (${entry.id}): registers, flags or scratch is missing.`)
    }
    const values: Record<string, string> = {}
    for (const name of registerOrder) {
      const value = registers[name]
      if (typeof value !== 'string' || !/^0x[0-9a-f]{16}$/.test(value)) {
        throw new Error(`${where} (${entry.id}): bad value for ${name}.`)
      }
      values[name] = value
    }
    const { CF, ZF, SF, OF } = flags
    if (!isBit(CF) || !isBit(ZF) || !isBit(SF) || !isBit(OF)) {
      throw new Error(`${where} (${entry.id}): a flag is not 0 or 1.`)
    }
    if (!new RegExp(`^[0-9a-f]{${2 * SCRATCH_BYTES}}$`).test(scratch)) {
      throw new Error(`${where} (${entry.id}): scratch must be ${2 * SCRATCH_BYTES} hex digits.`)
    }
    return { id: entry.id, body: entry.body, registers: values, flags: { CF, ZF, SF, OF }, scratch }
  })
  return {
    seed: typeof data.seed === 'number' ? data.seed : 0,
    host: typeof data.host === 'string' ? data.host : 'an unknown machine',
    registerOrder,
    programs,
  }
}

/** The complete program the emulator gets: the fixture's body between a header and `ret`. */
function buildSource(body: string): string {
  return [
    '    .intel_syntax noprefix',
    '    .data',
    `scratch: .zero ${SCRATCH_BYTES}`,
    '    .text',
    '    .globl main',
    'main:',
    body,
    '    ret',
    '',
  ].join('\n')
}

function hex64(value: bigint): string {
  return `0x${value.toString(16).padStart(16, '0')}`
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`
}

interface Difference {
  /** "register rbx", "flag ZF", "scratch byte 17 ([r15+17])". */
  what: string
  emulator: string
  cpu: string
}

/**
 * Run one program in the emulator and compare. Returns null when everything matches,
 * else the full failure message.
 */
function replay(program: FuzzProgram, fixture: FuzzFixture): string | null {
  const source = buildSource(program.body)
  const title = `cpu-fuzz ${program.id} (seed ${fixture.seed})`
  const listing = `The program (pass it to createEmulator to see it happen):\n\n${source}`

  const created = createEmulator(source)
  if (!created.ok) {
    const problems = created.diagnostics.map((item) => `  ${item.code}: ${item.message}`)
    return (
      `${title}: the program did not assemble, but it is valid for gcc and clang.\n` +
      `${problems.join('\n')}\n\n${listing}`
    )
  }
  const emulator = created.emulator

  const run = emulator.run()
  if (run.reason !== 'halted') {
    const state = emulator.getSnapshot()
    return (
      `${title}: run() stopped with reason '${run.reason}' instead of 'halted'.\n` +
      `  ${run.message}\n` +
      (state.error ? `  ${state.error.code}: ${state.error.message}\n` : '') +
      `\n${listing}`
    )
  }

  const differences: Difference[] = []

  for (const name of fixture.registerOrder) {
    const expected = program.registers[name]
    const actual = hex64(emulator.readRegister(name))
    if (expected !== undefined && actual !== expected) {
      differences.push({ what: `register ${name}`, emulator: actual, cpu: expected })
    }
  }

  const flags = emulator.getSnapshot().flags
  for (const name of FLAG_NAMES) {
    if (flags[name] !== program.flags[name]) {
      differences.push({
        what: `flag ${name}`,
        emulator: String(flags[name]),
        cpu: String(program.flags[name]),
      })
    }
  }

  const scratch = emulator.program.symbols.get('scratch')
  if (scratch === undefined) {
    return `${title}: program.symbols has no entry for the data label \`scratch\`.\n\n${listing}`
  }
  // A byte the program never wrote reads as null: on the real machine it holds 0.
  const bytes = emulator.readMemory(scratch.address, SCRATCH_BYTES)
  for (let offset = 0; offset < SCRATCH_BYTES; offset++) {
    const expected = Number.parseInt(program.scratch.slice(2 * offset, 2 * offset + 2), 16)
    const actual = bytes[offset] ?? 0
    if (actual !== expected) {
      differences.push({
        what: `scratch byte ${offset} ([r15+${offset}])`,
        emulator: hexByte(actual),
        cpu: hexByte(expected),
      })
    }
  }

  const first = differences[0]
  if (first === undefined) return null
  const others = differences.slice(1).map((item) => item.what)
  const shown = others.slice(0, 12).join(', ')
  const more = others.length > 12 ? `, and ${others.length - 12} more` : ''
  return (
    `${title}: the emulator does not match the real CPU.\n\n` +
    `First difference: ${first.what}\n` +
    `    emulator  ${first.emulator}\n` +
    `    real CPU  ${first.cpu}\n` +
    (others.length > 0 ? `Also different: ${shown}${more}\n` : '') +
    `\nThe real CPU values come from: ${fixture.host}.\n` +
    `rsp and r15 are not compared.\n` +
    `To see the first instruction that goes wrong (on a machine that can run x86-64 code):\n` +
    `    npm run verify:native -- --fuzz ${program.id} --show-steps\n\n${listing}`
  )
}

const fixtureText = fixtureFiles[FIXTURE_PATH]

if (fixtureText === undefined) {
  describe('cpu-fuzz: the emulator against a real x86-64 CPU', () => {
    it.skip(`needs src/emulator/__fixtures__/cpu-fuzz.json (make it with: ${HOW_TO_MAKE_IT})`, () => {
      // Nothing to replay without the fixture.
    })
  })
} else {
  const fixture = parseFixture(fixtureText)

  describe('cpu-fuzz: the fixture', () => {
    it('holds at least 400 programs with different ids', () => {
      expect(fixture.programs.length).toBeGreaterThanOrEqual(400)
      expect(new Set(fixture.programs.map((program) => program.id)).size).toBe(
        fixture.programs.length,
      )
    })

    it('compares every register except rsp and r15', () => {
      const expected = REG64_NAMES.filter((name) => name !== 'rsp' && name !== 'r15')
      expect([...fixture.registerOrder].sort()).toEqual([...expected].sort())
    })
  })

  // While `src/emulator/index.ts` has no createEmulator, say so in ONE failing test
  // instead of failing 600 times. (Nothing is skipped once the export exists.)
  const emulatorExists = typeof createEmulator === 'function'
  const replayEach = emulatorExists ? it.each(fixture.programs) : it.skip.each(fixture.programs)

  describe('cpu-fuzz: the emulator against a real x86-64 CPU', () => {
    it('can create an emulator (src/emulator/index.ts exports createEmulator)', () => {
      expect(emulatorExists).toBe(true)
    })

    replayEach('$id ends in the same state as on the real CPU', (program) => {
      const problem = replay(program, fixture)
      if (problem !== null) throw new Error(problem)
    })
  })
}
